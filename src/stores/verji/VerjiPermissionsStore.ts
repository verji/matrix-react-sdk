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
import { VerjiRoleReader } from "./verjiRoles";

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
 */
export class VerjiPermissionsStore extends ReadyWatchingStore implements VerjiRoleReader {
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

export default VerjiPermissionsStore;
