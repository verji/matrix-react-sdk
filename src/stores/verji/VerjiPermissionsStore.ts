/*
Copyright 2026 Verji Tech AS

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { Room } from "matrix-js-sdk/src/matrix";
import { getVerjiApiSdk, initVerjiApiSdkAsync } from "@verji/verji-api-sdk/lib/asyncInit";
import { convertToVerjiSdkConfig, VerjiAppConfig } from "@verji/verji-api-sdk/lib/utils/convertConfig";

import type { AccessContextSnapshot, PermissionStore } from "@verji/verji-api-sdk";
import SdkConfig from "../../SdkConfig";
import defaultDispatcher, { MatrixDispatcher } from "../../dispatcher/dispatcher";
import { ReadyWatchingStore } from "../ReadyWatchingStore";
import SpaceStore from "../spaces/SpaceStore";
import { UPDATE_TOP_LEVEL_SPACES } from "../spaces";
import { VerjiGateReader } from "./verjiGates";
import { isOrgUnitMemberOrOwner } from "./verjiRoles";

/**
 * VERJI: the bridge between `sdk.permissions` (the framework-agnostic access-context cache in
 * `@verji/verji-api-sdk`) and the Element client.
 *
 * It lives in the fork rather than in a module or in the SDK on purpose: the Verji runtime modules
 * already import fork internals, so one store here is reachable from all of them, while the SDK
 * stays free of React and of Element's lifecycle.
 *
 * ## The rollout switch
 *
 * {@link isCanonicalSpaceSyncEnabled} is the single input every gate short-circuits on. It is the
 * server's own evaluation of `hierarchy-v2.canonical-space-sync` for this tenant *and* this user,
 * echoed onto the access-context response, so client and backend cannot disagree about targeting
 * and no GrowthBook wiring exists in the client at all. It is false when the tenant has no cached
 * record, which is what makes every gate fail to today's behaviour rather than to a denial.
 *
 * ## Lifecycle
 *
 * {@link ReadyWatchingStore} gives us exactly the two edges that matter: `onReady` when a client is
 * up, and `onNotReady` on logout, on a non-viable client, and — crucially — when the synced client
 * changes identity, which is the user-switch case. `clearAll()` is called on those edges and
 * **never** on a tenant switch: caching tenants side by side is the entire point of the cache.
 *
 * ## Freshness after priming
 *
 * Priming fetches each tenant's context once per page load, and the SDK's read path never fetches,
 * so without more a permission change mid-session would go unseen until a reload
 * (verji/verji-src#1507). Two requests close that, both made by `useVerjiGate` from an effect —
 * never by a gate, never during render:
 * - {@link requestOrgUnitRefresh}: a bounded re-fetch while a gate is Checking an OrgUnit the
 *   context has never heard of, the guest-org-created-after-page-load case;
 * - {@link watchTenant}: while a gate reading a tenant is mounted, its copy is revalidated once it
 *   is older than the SDK's TTL, which caps every other kind of staleness at about the TTL.
 */
export class VerjiPermissionsStore extends ReadyWatchingStore implements VerjiGateReader {
    private static readonly internalInstance = (() => {
        const instance = new VerjiPermissionsStore(defaultDispatcher);
        instance.start();
        return instance;
    })();

    public static get instance(): VerjiPermissionsStore {
        return VerjiPermissionsStore.internalInstance;
    }

    /**
     * Monotonic counter bumped on every store event. The SDK store has no version of its own, so
     * the hook needs one to tell "something changed" from "nothing changed" across renders.
     */
    private version = 0;
    private changeListeners = new Set<() => void>();
    private unsubscribeSdk?: () => void;
    private permissions?: PermissionStore;
    private initialisedForUserId?: string;
    private primedForUserId?: string;
    private warnedMissingStore = false;
    /** One bounded re-fetch per (tenant, OrgUnit) pair — running or used up — keyed by {@link orgUnitKey}. */
    private orgUnitRefreshes = new Map<string, OrgUnitRefresh>();
    /** When the stale backstop last revalidated each tenant, for its throttle. */
    private staleRevalidatedAt = new Map<string, number>();
    /** How many mounted gates read each tenant. While any do, {@link staleCheckTimer} runs. */
    private watchedTenants = new Map<string, number>();
    private staleCheckTimer?: ReturnType<typeof setInterval>;

    public constructor(dispatcher: MatrixDispatcher) {
        super(dispatcher);
    }

    // ---------------------------------------------------------------- reads (synchronous)

    /**
     * The Hierarchy V2 rollout switch for a tenant. **Every gate must pass through this.** False
     * when the tenant has no cached record yet, which fails to today's behaviour by construction.
     */
    public isCanonicalSpaceSyncEnabled(tenantId: string): boolean {
        return this.permissions?.isCanonicalSpaceSyncEnabled(tenantId) ?? false;
    }

    /**
     * Mirrors the backend's `AcContext.HasRole`. Default-deny — false for an unknown tenant, an
     * unknown role, or a context that has not loaded. Ask through the predicates in `verjiRoles`,
     * never with a role name spelled at the call site.
     */
    public hasRole(tenantId: string, roleName: string, instanceId: string): boolean {
        return this.permissions?.hasRole(tenantId, roleName, instanceId) ?? false;
    }

    /** Load state of a tenant's access context — distinguishes "not loaded" from "denied". */
    public peekContext(tenantId: string): AccessContextSnapshot {
        return this.permissions?.peekContext(tenantId) ?? { status: "uninitialized" };
    }

    /**
     * Is `instanceId` in any role's instance list in the tenant's cached context? False when the
     * tenant has no cached context. Ask through `isOrgUnitInContext` in `verjiRoles`.
     */
    public isInstanceReferenced(tenantId: string, instanceId: string): boolean {
        const roles = this.permissions?.peekContext(tenantId).record?.roles;
        if (!roles) return false;
        return Object.values(roles).some((instances) => Array.isArray(instances) && instances.includes(instanceId));
    }

    /** See `VerjiGateReader.isOrgUnitRefreshExhausted`. */
    public isOrgUnitRefreshExhausted(tenantId: string, orgUnitId: string): boolean {
        return this.orgUnitRefreshes.get(orgUnitKey(tenantId, orgUnitId))?.exhausted ?? false;
    }

    // ---------------------------------------------------------------- freshness (from effects only)

    /**
     * Re-fetch the tenant's access context on a short backoff ({@link ORG_UNIT_REFRESH_DELAYS_MS})
     * until it shows the user as a Member or the Owner of `orgUnitId`, then stop. If it never does,
     * mark the pair exhausted, which settles a gate still at Checking on Denied.
     *
     * One schedule per (tenant, OrgUnit) pair until logout or user switch: a call for a pair that is
     * running or used up does nothing, which is what makes it safe to call after every render and
     * rules out a loop. Concurrent fetches for one tenant are deduplicated by the SDK.
     */
    public requestOrgUnitRefresh(tenantId: string, orgUnitId: string): void {
        if (!this.permissions) return;
        const key = orgUnitKey(tenantId, orgUnitId);
        if (this.orgUnitRefreshes.has(key)) return;

        const refresh: OrgUnitRefresh = { exhausted: false };
        this.orgUnitRefreshes.set(key, refresh);
        this.scheduleOrgUnitAttempt(refresh, tenantId, orgUnitId, 0);
    }

    /**
     * Keep the tenant's copy within about the SDK's TTL until the returned function is called:
     * check it now and every {@link STALE_CHECK_INTERVAL_MS}, and revalidate it in the background
     * once it is stale. `useVerjiGate` holds one for the tenant of the space it renders.
     *
     * A timer, not a check on render: a gate that nothing re-renders — a quiet room list, whose
     * sublists skip updates — would otherwise trust a stale copy for as long as the tab is open.
     * The timer runs only while some gate is mounted, and costs a request only once a copy is stale.
     */
    public watchTenant(tenantId: string): () => void {
        this.watchedTenants.set(tenantId, (this.watchedTenants.get(tenantId) ?? 0) + 1);
        this.staleCheckTimer ??= setInterval(this.revalidateWatchedTenants, STALE_CHECK_INTERVAL_MS);
        this.revalidateIfStale(tenantId);

        let watching = true;
        return () => {
            if (!watching) return;
            watching = false;
            const readers = (this.watchedTenants.get(tenantId) ?? 1) - 1;
            if (readers > 0) this.watchedTenants.set(tenantId, readers);
            else this.watchedTenants.delete(tenantId);
            if (this.watchedTenants.size === 0) {
                clearInterval(this.staleCheckTimer);
                this.staleCheckTimer = undefined;
            }
        };
    }

    private revalidateWatchedTenants = (): void => {
        for (const tenantId of this.watchedTenants.keys()) this.revalidateIfStale(tenantId);
    };

    /**
     * Revalidate the tenant's access context in the background if the cached copy is older than the
     * SDK's TTL. A tenant with no copy is left alone: it reads NotGated, as it does today.
     *
     * Throttled per tenant, because a failed revalidation leaves the copy stale and every check
     * would otherwise send another request.
     */
    private revalidateIfStale(tenantId: string): void {
        const permissions = this.permissions;
        if (!permissions || permissions.peekContext(tenantId).status !== "stale") return;

        const now = Date.now();
        const last = this.staleRevalidatedAt.get(tenantId);
        if (last !== undefined && now - last < STALE_REVALIDATION_THROTTLE_MS) return;
        this.staleRevalidatedAt.set(tenantId, now);

        // A stale copy is returned at once and revalidated in the background; the SDK logs a failed
        // revalidation itself. This catch is for the call itself failing.
        permissions.ensureContextFresh(tenantId).catch((error) => {
            // eslint-disable-next-line no-console
            console.warn("[Verji.Permissions] Failed to revalidate the access context for tenant", tenantId, error);
        });
    }

    private scheduleOrgUnitAttempt(
        refresh: OrgUnitRefresh,
        tenantId: string,
        orgUnitId: string,
        attempt: number,
    ): void {
        refresh.timer = setTimeout(() => {
            refresh.timer = undefined;
            void this.runOrgUnitAttempt(refresh, tenantId, orgUnitId, attempt);
        }, ORG_UNIT_REFRESH_DELAYS_MS[attempt]);
    }

    private async runOrgUnitAttempt(
        refresh: OrgUnitRefresh,
        tenantId: string,
        orgUnitId: string,
        attempt: number,
    ): Promise<void> {
        const key = orgUnitKey(tenantId, orgUnitId);
        // A reset clears pending timers along with the store, so a timer that fires has both.
        const permissions = this.permissions;
        if (!permissions) return;

        // Another fetch may have settled it since this attempt was scheduled.
        if (!isOrgUnitMemberOrOwner(this, tenantId, orgUnitId)) {
            try {
                await permissions.refreshContext(tenantId);
            } catch (error) {
                // A failed attempt still counts against the budget; the next one may succeed.
                // eslint-disable-next-line no-console
                console.warn("[Verji.Permissions] Failed to refresh the access context for tenant", tenantId, error);
            }
            // Logout or a user switch while the request was in flight: this schedule is void.
            if (this.orgUnitRefreshes.get(key) !== refresh) return;
        }

        if (isOrgUnitMemberOrOwner(this, tenantId, orgUnitId)) {
            // Settled. The fetch that brought the row changed the context, so the SDK has already
            // emitted and the gate has re-rendered as Allowed. Marking the pair used up all the
            // same is what keeps a later drop — the user is removed from the OrgUnit — at Denied,
            // rather than back at a Checking that no schedule would ever settle.
            refresh.exhausted = true;
            return;
        }
        // Not settled merely because the OrgUnit is now in the context under some other role: the
        // gate already reads Denied for that, but before verji/verji-src#1495 a row other than the
        // Owner row — the tenant PrimaryContact's manager roles, the group sync's ownership row —
        // can name a new guest org before its Owner row lands. So keep going to the end of the budget.
        if (attempt + 1 < ORG_UNIT_REFRESH_DELAYS_MS.length) {
            this.scheduleOrgUnitAttempt(refresh, tenantId, orgUnitId, attempt + 1);
            return;
        }
        refresh.exhausted = true;
        // The last fetch may have changed nothing, leaving the SDK silent: this is what moves a gate
        // still at Checking to Denied.
        this.bumpVersion();
    }

    /**
     * The tenants mounted gates read are left as they are: the gates belong to mounted components,
     * not to the user, and the same interval checks the next user's copies once their store is up.
     */
    private resetFreshnessRequests(): void {
        for (const refresh of this.orgUnitRefreshes.values()) clearTimeout(refresh.timer);
        this.orgUnitRefreshes.clear();
        this.staleRevalidatedAt.clear();
    }

    // ---------------------------------------------------------------- reactivity

    /** Subscribe to changes. Returns an unsubscribe fn. Consumed by `useVerjiGate`. */
    public subscribe = (listener: () => void): (() => void) => {
        this.changeListeners.add(listener);
        return () => {
            this.changeListeners.delete(listener);
        };
    };

    /** Current version — changes whenever the store's content changed. */
    public getVersion = (): number => this.version;

    private bumpVersion(): void {
        this.version++;
        for (const listener of this.changeListeners) listener();
    }

    // ---------------------------------------------------------------- lifecycle

    protected async onReady(): Promise<void> {
        const client = this.matrixClient;
        const userId = client?.getUserId();
        if (!client || !userId) return;

        // `IConfigOptions` does not declare the Verji URLs; the Verji runtime modules cast the same
        // way (see verji-roomsublist-module's `VerjiConfig`).
        const appConfig = SdkConfig.get() as Partial<VerjiAppConfig>;

        // Bail before touching the SDK when itops is not configured. `initVerjiApiSdkAsync` retries
        // for ten seconds waiting for a URL to appear, which is pure noise (and a lingering timer
        // under jest) for any deployment — or test — that has no itops at all. The gates then read
        // NotGated everywhere, which is today's behaviour.
        if (!appConfig?.verjiItopsUrl) {
            if (!this.warnedMissingStore) {
                this.warnedMissingStore = true;
                // eslint-disable-next-line no-console
                console.warn(
                    "[Verji.Permissions] verjiItopsUrl is not configured — Hierarchy V2 gating stays off " +
                        "and every affordance renders as it does today.",
                );
            }
            return;
        }

        let permissions: PermissionStore | undefined;
        try {
            await initVerjiApiSdkAsync(() => convertToVerjiSdkConfig(appConfig));
            const sdk = await getVerjiApiSdk();
            permissions = sdk.permissions;
            if (!permissions) {
                if (!this.warnedMissingStore) {
                    this.warnedMissingStore = true;
                    // eslint-disable-next-line no-console
                    console.warn(
                        "[Verji.Permissions] sdk.permissions unavailable (verjiItopsUrl not configured) — " +
                            "Hierarchy V2 gating stays off and every affordance renders as it does today.",
                    );
                }
                return;
            }

            // Subscribe BEFORE init, or the one-shot "hydrated" event fired while init reads
            // IndexedDB is lost and the first render never learns the cache was warm.
            this.unsubscribeSdk ??= permissions.subscribe(() => this.bumpVersion());

            await permissions.init({
                userId,
                // Read the macaroon fresh on every call rather than closing over it: the SDK asks
                // for a token long after this point, and getAccessToken is cheap when cached.
                getToken: async () => {
                    const sdkInstance = await getVerjiApiSdk();
                    const macaroon = client.getAccessToken() ?? "";
                    return sdkInstance.api.identityService!.getAccessToken(macaroon);
                },
            });
        } catch (error) {
            // eslint-disable-next-line no-console
            console.error("[Verji.Permissions] Failed to initialise the access-context store:", error);
            return;
        }

        this.permissions = permissions;
        this.initialisedForUserId = userId;
        this.bumpVersion();

        this.startPriming(userId);
    }

    protected async onNotReady(): Promise<void> {
        // Logout, a non-viable client, or a different user. NOT a tenant switch — the dispatcher
        // actions this store watches do not fire for those, and they must not.
        this.unsubscribeSdk?.();
        this.unsubscribeSdk = undefined;
        SpaceStore.instance.off(UPDATE_TOP_LEVEL_SPACES, this.onTopLevelSpacesUpdated);

        const permissions = this.permissions;
        this.permissions = undefined;
        this.initialisedForUserId = undefined;
        this.primedForUserId = undefined;
        // The re-fetch budget and the throttle belong to the user who spent them.
        this.resetFreshnessRequests();
        this.bumpVersion();

        if (!permissions) return;
        try {
            await permissions.clearAll();
        } catch (error) {
            // eslint-disable-next-line no-console
            console.warn("[Verji.Permissions] Failed to clear the access-context store:", error);
        }
        // `init` is idempotent-by-promise, so a re-init for a different user would skip its own
        // owner-scope wipe unless the store is disposed first.
        permissions.dispose();
    }

    // ---------------------------------------------------------------- priming

    /**
     * Prime rather than fetch lazily: walk the top-level spaces once and warm the access context
     * for each distinct tenant. That set *is* the navigable tenant set, so it needs no
     * `GET /acl/tenants` call, and it means switching to a second tenant renders without a
     * "checking…" state.
     *
     * Within a tenant, switching OrgUnit spaces is then zero-network: the OrgUnit id is a
     * synchronous room-state read and the tenant's context already carries every instance the user
     * is directly granted on.
     */
    private startPriming(userId: string): void {
        if (this.primedForUserId === userId) return;

        const spaces = SpaceStore.instance.spacePanelSpaces;
        if (spaces.length > 0) {
            this.primedForUserId = userId;
            void this.primeTenantsForSpaces(spaces);
            return;
        }
        // Spaces have not loaded yet — wait for the first update, then unsubscribe. Same shape the
        // roomsublist module uses for its DM prefetch.
        SpaceStore.instance.on(UPDATE_TOP_LEVEL_SPACES, this.onTopLevelSpacesUpdated);
    }

    private onTopLevelSpacesUpdated = (spaces: Room[]): void => {
        const userId = this.initialisedForUserId;
        if (!userId || this.primedForUserId === userId) return;
        this.primedForUserId = userId;
        SpaceStore.instance.off(UPDATE_TOP_LEVEL_SPACES, this.onTopLevelSpacesUpdated);
        void this.primeTenantsForSpaces(spaces);
    };

    private async primeTenantsForSpaces(spaces: Room[]): Promise<void> {
        const permissions = this.permissions;
        if (!permissions) return;

        const tenantIds = new Set<string>();
        for (const space of spaces) {
            try {
                const tenantId = space.currentState
                    .getStateEvents("app.verji.tenant_info", "app.verji.tenant_info")
                    ?.getContent()?.tenant_id;
                if (typeof tenantId === "string" && tenantId.length > 0) tenantIds.add(tenantId);
            } catch (error) {
                // A single unreadable space must not stop the rest being primed.
                // eslint-disable-next-line no-console
                console.warn("[Verji.Permissions] Could not read tenant_info for space", space.roomId, error);
            }
        }

        // Bounded fan-out, matching the SDK's own PREFETCH_ALL_CONCURRENCY, so a user with many
        // tenants does not burst-fire requests at itops.
        const queue = [...tenantIds];
        const workers = Array.from({ length: Math.min(PRIME_CONCURRENCY, queue.length) }, async () => {
            for (let tenantId = queue.shift(); tenantId !== undefined; tenantId = queue.shift()) {
                try {
                    await permissions.ensureContextFresh(tenantId);
                } catch (error) {
                    // eslint-disable-next-line no-console
                    console.warn("[Verji.Permissions] Failed to prime access context for tenant", tenantId, error);
                }
            }
        });
        await Promise.all(workers);
    }
}

/** Mirrors the SDK's own `PREFETCH_ALL_CONCURRENCY`. */
const PRIME_CONCURRENCY = 4;

/**
 * The wait before each re-fetch of {@link VerjiPermissionsStore.requestOrgUnitRefresh}: one at
 * once, then backing off, about a minute in all. Sized for the backend as deployed before
 * verji/verji-src#1495, where the Owner row of a new guest org lands about 40–50 s after its space
 * appears; with #1495 the first re-fetch finds it.
 */
export const ORG_UNIT_REFRESH_DELAYS_MS: readonly number[] = [0, 2_000, 5_000, 10_000, 20_000, 30_000];

/**
 * How often {@link VerjiPermissionsStore.watchTenant} looks at the copies of the tenants mounted
 * gates read. A look is a map read; it costs a request only once a copy is past the SDK's TTL, so
 * a copy is trusted for at most the TTL plus this.
 */
export const STALE_CHECK_INTERVAL_MS = 30_000;

/** The least time between two stale-backstop revalidations of one tenant. */
export const STALE_REVALIDATION_THROTTLE_MS = 30_000;

/** The state of one (tenant, OrgUnit) re-fetch. */
interface OrgUnitRefresh {
    /** The pending attempt; undefined while an attempt is in flight and once the schedule ends. */
    timer?: ReturnType<typeof setTimeout>;
    /** The schedule has ended, by running out of attempts or by finding the user a Member or the Owner. */
    exhausted: boolean;
}

/** Tenant and OrgUnit ids are GUIDs, so JSON keeps the pair unambiguous at no cost. */
const orgUnitKey = (tenantId: string, orgUnitId: string): string => JSON.stringify([tenantId, orgUnitId]);

export default VerjiPermissionsStore;
