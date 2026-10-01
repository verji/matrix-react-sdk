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

import { mocked } from "jest-mock";
import { MatrixClient, MatrixEvent, Room, SyncState } from "matrix-js-sdk/src/matrix";
import { getVerjiApiSdk, initVerjiApiSdkAsync } from "@verji/verji-api-sdk/lib/asyncInit";

import type { PermissionChangeListener, PermissionStore } from "@verji/verji-api-sdk";
import {
    ORG_UNIT_REFRESH_DELAYS_MS,
    STALE_CHECK_INTERVAL_MS,
    STALE_REVALIDATION_THROTTLE_MS,
    VerjiPermissionsStore,
} from "../../../src/stores/verji/VerjiPermissionsStore";
import { MatrixDispatcher } from "../../../src/dispatcher/dispatcher";
import { Action } from "../../../src/dispatcher/actions";
import SdkConfig from "../../../src/SdkConfig";
import SpaceStore from "../../../src/stores/spaces/SpaceStore";
import { UPDATE_TOP_LEVEL_SPACES } from "../../../src/stores/spaces";
import { flushPromises, getMockClientWithEventEmitter, mockClientMethodsUser } from "../../test-utils";

jest.mock("@verji/verji-api-sdk/lib/asyncInit", () => ({
    initVerjiApiSdkAsync: jest.fn(),
    getVerjiApiSdk: jest.fn(),
}));

const USER = "@alice:domain.org";
const TENANT = "tenant-1";
const ORG_A = "org-a";
const ORG_B = "org-b";

/**
 * A stand-in for `sdk.permissions` that knows TENANT: the rollout switch is on there and the user
 * is a StandardUser of it. Everything else reads as unknown, as the real store answers.
 */
const makePermissions = () => {
    const listeners = new Set<PermissionChangeListener>();
    const unsubscribe = jest.fn();
    /** TENANT's cached context. Tests change it to play a fetch that brought new content. */
    const context: { status: "fresh" | "stale"; roles: Record<string, string[]> } = {
        status: "fresh",
        roles: { "Customer-User#": [TENANT] },
    };
    return {
        init: jest.fn().mockResolvedValue(undefined),
        isCanonicalSpaceSyncEnabled: jest.fn((tenantId: string) => tenantId === TENANT),
        hasRole: jest.fn(
            (tenantId: string, roleName: string, instanceId: string) =>
                tenantId === TENANT && (context.roles[roleName] ?? []).includes(instanceId),
        ),
        peekContext: jest.fn((tenantId: string) =>
            tenantId === TENANT ? { status: context.status, record: { roles: context.roles } } : { status: "missing" },
        ),
        ensureContextFresh: jest.fn().mockResolvedValue(undefined),
        refreshContext: jest.fn().mockResolvedValue(undefined),
        subscribe: jest.fn((listener: PermissionChangeListener) => {
            listeners.add(listener);
            return unsubscribe;
        }),
        clearAll: jest.fn().mockResolvedValue(undefined),
        dispose: jest.fn(),
        /** Test hook: emit a change the way the SDK store does. */
        emit: (): void => listeners.forEach((listener) => listener({ type: "contextUpdated", tenantId: TENANT })),
        unsubscribe,
        context,
    };
};
type FakePermissions = ReturnType<typeof makePermissions>;

/** A real Room carrying `app.verji.tenant_info`, or no Verji state at all when `tenantId` is undefined. */
const makeSpace = (client: MatrixClient, roomId: string, tenantId?: string): Room => {
    const room = new Room(roomId, client, USER);
    if (tenantId) {
        room.currentState.setStateEvents([
            new MatrixEvent({
                type: "app.verji.tenant_info",
                state_key: "app.verji.tenant_info",
                room_id: roomId,
                sender: USER,
                content: { tenant_id: tenantId },
            }),
        ]);
    }
    return room;
};

describe("VerjiPermissionsStore", () => {
    let client: MatrixClient;
    let dispatcher: MatrixDispatcher;
    let permissions: FakePermissions;
    let identityGetAccessToken: jest.Mock;
    let spacePanelSpaces: Room[];

    /** Wire the SDK mock to hand out `sdkPermissions` as `sdk.permissions`. */
    const provideSdk = (sdkPermissions: FakePermissions | undefined): void => {
        mocked(initVerjiApiSdkAsync).mockResolvedValue(undefined as never);
        mocked(getVerjiApiSdk).mockResolvedValue({
            permissions: sdkPermissions as unknown as PermissionStore,
            api: { identityService: { getAccessToken: identityGetAccessToken } },
        } as never);
    };

    /** A store whose `start` runs `onReady` against `client` (via MatrixClientPeg). */
    const startedStore = async (): Promise<VerjiPermissionsStore> => {
        const store = new VerjiPermissionsStore(dispatcher);
        await store.start();
        return store;
    };

    /** Dispatch synchronously, then let the store's async handler settle. */
    const dispatchAndSettle = async (payload: Parameters<MatrixDispatcher["dispatch"]>[0]): Promise<void> => {
        dispatcher.dispatch(payload, true);
        await flushPromises();
    };

    beforeEach(() => {
        client = getMockClientWithEventEmitter({
            ...mockClientMethodsUser(USER),
            getAccessToken: jest.fn().mockReturnValue("macaroon"),
        });
        dispatcher = new MatrixDispatcher();
        permissions = makePermissions();
        identityGetAccessToken = jest.fn().mockResolvedValue("verji-access-token");
        provideSdk(permissions);
        SdkConfig.put({ verjiItopsUrl: "https://itops.test" } as never);

        spacePanelSpaces = [];
        jest.spyOn(SpaceStore.instance, "spacePanelSpaces", "get").mockImplementation(() => spacePanelSpaces);
        jest.spyOn(console, "warn").mockImplementation(() => {});
        jest.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        SdkConfig.reset();
        SpaceStore.instance.removeAllListeners(UPDATE_TOP_LEVEL_SPACES);
        jest.restoreAllMocks();
    });

    /**
     * The fail-safe default. Whenever there is no SDK store to ask — before the first client is up,
     * itops unconfigured, init failed, or just after logout — the rollout switch must read OFF.
     * Reading it on while every role reads denied disables Persons+ and Rooms "+" for every user of
     * every tenant: the worst defect available in this feature.
     */
    describe("with no SDK store to ask", () => {
        const expectOutsideTheBeta = (store: VerjiPermissionsStore): void => {
            expect(store.isCanonicalSpaceSyncEnabled(TENANT)).toBe(false);
            expect(store.hasRole(TENANT, "Customer-User#", TENANT)).toBe(false);
            expect(store.peekContext(TENANT)).toEqual({ status: "uninitialized" });
            expect(store.isInstanceReferenced(TENANT, TENANT)).toBe(false);
            expect(store.isOrgUnitRefreshExhausted(TENANT, ORG_A)).toBe(false);
        };

        it("reads outside the beta before any client is ready", () => {
            expectOutsideTheBeta(new VerjiPermissionsStore(dispatcher));
        });

        it("reads outside the beta when itops is not configured, without touching the SDK", async () => {
            SdkConfig.reset();

            const store = await startedStore();

            expectOutsideTheBeta(store);
            expect(initVerjiApiSdkAsync).not.toHaveBeenCalled();
        });

        it("reads outside the beta when the SDK has no permissions store", async () => {
            provideSdk(undefined);

            expectOutsideTheBeta(await startedStore());
        });

        it("reads outside the beta when the SDK store fails to initialise", async () => {
            // The fake would answer "on" for TENANT; a store that failed init must not be consulted.
            permissions.init.mockRejectedValue(new Error("IndexedDB unavailable"));

            expectOutsideTheBeta(await startedStore());
        });
    });

    describe("once initialised", () => {
        it("reads through to sdk.permissions, keyed by the tenant asked about", async () => {
            const store = await startedStore();

            expect(store.isCanonicalSpaceSyncEnabled(TENANT)).toBe(true);
            expect(store.isCanonicalSpaceSyncEnabled("tenant-2")).toBe(false);
            expect(store.hasRole(TENANT, "Customer-User#", TENANT)).toBe(true);
            expect(permissions.hasRole).toHaveBeenCalledWith(TENANT, "Customer-User#", TENANT);
            expect(store.peekContext(TENANT).status).toBe("fresh");
        });

        it("finds an instance under any role, in the tenant asked about only", async () => {
            permissions.context.roles["ClientOrganization-SmsRoomMember"] = [ORG_A];
            const store = await startedStore();

            expect(store.isInstanceReferenced(TENANT, ORG_A)).toBe(true);
            expect(store.isInstanceReferenced(TENANT, ORG_B)).toBe(false);
            expect(store.isInstanceReferenced("tenant-2", ORG_A)).toBe(false);
        });

        it("initialises the SDK store for the signed-in user", async () => {
            await startedStore();

            expect(permissions.init).toHaveBeenCalledWith(expect.objectContaining({ userId: USER }));
        });

        it("exchanges the current macaroon for a Verji token whenever the SDK asks", async () => {
            await startedStore();
            const { getToken } = permissions.init.mock.calls[0][0];

            await expect(getToken()).resolves.toBe("verji-access-token");
            expect(identityGetAccessToken).toHaveBeenCalledWith("macaroon");
        });

        it("subscribes to the SDK store before initialising it", async () => {
            // The one-shot "hydrated" event fires during init; subscribing after would miss it and
            // the first render would never learn the cache was warm.
            await startedStore();

            expect(permissions.subscribe.mock.invocationCallOrder[0]).toBeLessThan(
                permissions.init.mock.invocationCallOrder[0],
            );
        });

        it("bumps its version and notifies listeners when the SDK store emits", async () => {
            const store = await startedStore();
            const listener = jest.fn();
            const unsubscribe = store.subscribe(listener);
            const before = store.getVersion();

            permissions.emit();

            expect(listener).toHaveBeenCalledTimes(1);
            expect(store.getVersion()).toBeGreaterThan(before);

            unsubscribe();
            permissions.emit();
            expect(listener).toHaveBeenCalledTimes(1);
        });
    });

    /**
     * Logout and user switch. Leaving user A's access contexts behind would decide user B's
     * affordances with user A's roles, in the same tab.
     */
    describe("on logout", () => {
        it("clears and disposes the SDK store, and reads outside the beta again", async () => {
            const store = await startedStore();
            expect(store.isCanonicalSpaceSyncEnabled(TENANT)).toBe(true);

            await dispatchAndSettle({ action: Action.OnLoggedOut });

            expect(permissions.clearAll).toHaveBeenCalledTimes(1);
            expect(permissions.dispose).toHaveBeenCalledTimes(1);
            expect(store.isCanonicalSpaceSyncEnabled(TENANT)).toBe(false);
            expect(store.hasRole(TENANT, "Customer-User#", TENANT)).toBe(false);
        });

        it("drops its SDK subscription and its space-panel listener", async () => {
            const listenersBefore = SpaceStore.instance.listenerCount(UPDATE_TOP_LEVEL_SPACES);
            await startedStore(); // no spaces yet, so it is waiting on the space panel
            expect(SpaceStore.instance.listenerCount(UPDATE_TOP_LEVEL_SPACES)).toBe(listenersBefore + 1);

            await dispatchAndSettle({ action: Action.OnLoggedOut });

            expect(permissions.unsubscribe).toHaveBeenCalledTimes(1);
            expect(SpaceStore.instance.listenerCount(UPDATE_TOP_LEVEL_SPACES)).toBe(listenersBefore);
        });

        it("tells its own listeners, so mounted gates re-render as outside the beta", async () => {
            const store = await startedStore();
            const listener = jest.fn();
            store.subscribe(listener);

            await dispatchAndSettle({ action: Action.OnLoggedOut });

            expect(listener).toHaveBeenCalled();
        });
    });

    describe("on a user switch", () => {
        it("disposes the first user's store before initialising for the second", async () => {
            await startedStore();
            const secondClient = getMockClientWithEventEmitter({
                ...mockClientMethodsUser("@bob:domain.org"),
                getAccessToken: jest.fn().mockReturnValue("macaroon-2"),
            });

            await dispatchAndSettle({
                action: "MatrixActions.sync",
                prevState: SyncState.Syncing,
                state: SyncState.Prepared,
                matrixClient: secondClient,
            });

            expect(permissions.clearAll).toHaveBeenCalledTimes(1);
            expect(permissions.dispose).toHaveBeenCalledTimes(1);
            expect(permissions.init).toHaveBeenCalledTimes(2);
            expect(permissions.init.mock.calls[1][0]).toEqual(expect.objectContaining({ userId: "@bob:domain.org" }));
            // init is idempotent-by-promise, so without the dispose first it would skip its own
            // owner-scope wipe for the new user.
            expect(permissions.dispose.mock.invocationCallOrder[0]).toBeLessThan(
                permissions.init.mock.invocationCallOrder[1],
            );
        });
    });

    describe("on a space or tenant switch", () => {
        it("keeps every cached tenant", async () => {
            // Caching tenants side by side is the point of the cache.
            await startedStore();

            await dispatchAndSettle({ action: Action.SwitchSpace, num: 1 });
            await dispatchAndSettle({ action: Action.ViewRoom, room_id: "!elsewhere:domain.org" });

            expect(permissions.clearAll).not.toHaveBeenCalled();
            expect(permissions.dispose).not.toHaveBeenCalled();
        });
    });

    describe("priming", () => {
        it("warms each distinct tenant of the top-level spaces once", async () => {
            spacePanelSpaces = [
                makeSpace(client, "!a:domain.org", TENANT),
                makeSpace(client, "!b:domain.org", TENANT),
                makeSpace(client, "!c:domain.org", "tenant-2"),
                makeSpace(client, "!not-verji:domain.org"),
            ];

            await startedStore();
            await flushPromises();

            expect(permissions.ensureContextFresh.mock.calls.map(([tenantId]) => tenantId).sort()).toEqual([
                TENANT,
                "tenant-2",
            ]);
        });

        it("waits for the space panel when no spaces have loaded yet, then primes once", async () => {
            await startedStore();
            expect(permissions.ensureContextFresh).not.toHaveBeenCalled();

            const spaces = [makeSpace(client, "!a:domain.org", TENANT)];
            SpaceStore.instance.emit(UPDATE_TOP_LEVEL_SPACES, spaces);
            SpaceStore.instance.emit(UPDATE_TOP_LEVEL_SPACES, spaces);
            await flushPromises();

            expect(permissions.ensureContextFresh).toHaveBeenCalledTimes(1);
            expect(permissions.ensureContextFresh).toHaveBeenCalledWith(TENANT);
        });
    });

    /**
     * verji/verji-src#1507: the bounded re-fetch behind the create-room gate's Checking verdict. The
     * two properties that matter are that it finds an OrgUnit created after page load, and that it
     * always ends — a gate must never sit at "checking", or poll itops, for the life of the tab.
     */
    describe("the re-fetch for an OrgUnit the context has never heard of", () => {
        /** Long enough for any schedule to have run its course several times over. */
        const LONG_AFTER = 10 * 60_000;

        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        it("re-fetches at once, then backs off, then gives up and re-renders the gates", async () => {
            const store = await startedStore();
            const listener = jest.fn();
            store.subscribe(listener);

            store.requestOrgUnitRefresh(TENANT, ORG_A);
            // Never synchronously: the caller is an effect, and the fetch goes out from a timer.
            expect(permissions.refreshContext).not.toHaveBeenCalled();

            // The first attempt goes out on the next tick.
            await jest.advanceTimersByTimeAsync(0);
            expect(permissions.refreshContext).toHaveBeenCalledTimes(1);

            // Each later one waits its full delay after the previous one, and not a moment less.
            for (const [index, delay] of ORG_UNIT_REFRESH_DELAYS_MS.slice(1).entries()) {
                const attemptsSoFar = index + 1;
                expect(store.isOrgUnitRefreshExhausted(TENANT, ORG_A)).toBe(false);

                await jest.advanceTimersByTimeAsync(delay - 1);
                expect(permissions.refreshContext).toHaveBeenCalledTimes(attemptsSoFar);
                await jest.advanceTimersByTimeAsync(1);
                expect(permissions.refreshContext).toHaveBeenCalledTimes(attemptsSoFar + 1);
                expect(permissions.refreshContext).toHaveBeenLastCalledWith(TENANT);
            }
            expect(store.isOrgUnitRefreshExhausted(TENANT, ORG_A)).toBe(true);
            // The context never changed, so the SDK never emitted: this bump is the only thing that
            // moves the gate from Checking to Denied.
            expect(listener).toHaveBeenCalledTimes(1);

            // No loop: asking again for a used-up pair does nothing, however long it stays on screen.
            store.requestOrgUnitRefresh(TENANT, ORG_A);
            await jest.advanceTimersByTimeAsync(LONG_AFTER);
            expect(permissions.refreshContext).toHaveBeenCalledTimes(ORG_UNIT_REFRESH_DELAYS_MS.length);
        });

        it("stops as soon as a re-fetch brings the OrgUnit in", async () => {
            const store = await startedStore();
            permissions.refreshContext.mockImplementation(async () => {
                // The second fetch is the one that lands after the backend wrote the Owner row.
                if (permissions.refreshContext.mock.calls.length === 2) {
                    permissions.context.roles["ClientOrganization-Owner"] = [ORG_A];
                }
            });

            store.requestOrgUnitRefresh(TENANT, ORG_A);
            await jest.advanceTimersByTimeAsync(LONG_AFTER);

            expect(permissions.refreshContext).toHaveBeenCalledTimes(2);
        });

        it("counts a pair whose OrgUnit turned up as used up, so a later drop reads Denied, not Checking", async () => {
            // Found through a room the user joined there. When they later leave their last room, a
            // revalidation drops the row; the gate must then deny, because nothing would ever ask
            // for this pair again to settle a Checking.
            const store = await startedStore();
            permissions.refreshContext.mockImplementation(async () => {
                permissions.context.roles["ClientOrganization-SmsRoomMember"] = [ORG_A];
            });
            store.requestOrgUnitRefresh(TENANT, ORG_A);
            await jest.advanceTimersByTimeAsync(0);
            expect(store.isInstanceReferenced(TENANT, ORG_A)).toBe(true);

            delete permissions.context.roles["ClientOrganization-SmsRoomMember"];

            expect(store.isInstanceReferenced(TENANT, ORG_A)).toBe(false);
            expect(store.isOrgUnitRefreshExhausted(TENANT, ORG_A)).toBe(true);
        });

        it("waits 0, 2, 5, 10, 20 and 30 s — sized to outlast the Owner row before #1495", () => {
            // Pinned literally: the loop above walks whatever the constant holds, so only this
            // catches a budget shrunk below the 40–50 s the Owner row took on staging.
            expect(ORG_UNIT_REFRESH_DELAYS_MS).toEqual([0, 2_000, 5_000, 10_000, 20_000, 30_000]);
        });

        it("keys a schedule by tenant as well as OrgUnit", async () => {
            const store = await startedStore();
            store.requestOrgUnitRefresh(TENANT, ORG_A);
            await jest.advanceTimersByTimeAsync(LONG_AFTER);
            expect(store.isOrgUnitRefreshExhausted(TENANT, ORG_A)).toBe(true);

            // The same OrgUnit id under another tenant is another pair, with a budget of its own.
            expect(store.isOrgUnitRefreshExhausted("tenant-2", ORG_A)).toBe(false);
            permissions.refreshContext.mockClear();
            store.requestOrgUnitRefresh("tenant-2", ORG_A);
            await jest.advanceTimersByTimeAsync(0);
            expect(permissions.refreshContext).toHaveBeenCalledWith("tenant-2");
        });

        it("skips the fetch when another one already brought the OrgUnit in", async () => {
            const store = await startedStore();
            const listener = jest.fn();
            store.subscribe(listener);

            store.requestOrgUnitRefresh(TENANT, ORG_A);
            permissions.context.roles["ClientOrganization-User#"] = [ORG_A];
            await jest.advanceTimersByTimeAsync(LONG_AFTER);

            expect(permissions.refreshContext).not.toHaveBeenCalled();
            // Nothing to re-render for: the fetch that changed the context was announced by the SDK.
            expect(listener).not.toHaveBeenCalled();
        });

        it("runs one schedule per (tenant, OrgUnit), however often it is asked", async () => {
            const store = await startedStore();

            store.requestOrgUnitRefresh(TENANT, ORG_A);
            store.requestOrgUnitRefresh(TENANT, ORG_A);
            store.requestOrgUnitRefresh(TENANT, ORG_A);
            await jest.advanceTimersByTimeAsync(0);
            expect(permissions.refreshContext).toHaveBeenCalledTimes(1);

            // A second OrgUnit is a second schedule, with a budget of its own.
            store.requestOrgUnitRefresh(TENANT, ORG_B);
            await jest.advanceTimersByTimeAsync(0);
            expect(permissions.refreshContext).toHaveBeenCalledTimes(2);

            await jest.advanceTimersByTimeAsync(LONG_AFTER);
            expect(permissions.refreshContext).toHaveBeenCalledTimes(2 * ORG_UNIT_REFRESH_DELAYS_MS.length);
            expect(store.isOrgUnitRefreshExhausted(TENANT, ORG_A)).toBe(true);
            expect(store.isOrgUnitRefreshExhausted(TENANT, ORG_B)).toBe(true);
        });

        it("keeps to the schedule when a fetch fails, and still ends", async () => {
            const store = await startedStore();
            permissions.refreshContext.mockRejectedValue(new Error("itops unavailable"));

            store.requestOrgUnitRefresh(TENANT, ORG_A);
            await jest.advanceTimersByTimeAsync(LONG_AFTER);

            expect(permissions.refreshContext).toHaveBeenCalledTimes(ORG_UNIT_REFRESH_DELAYS_MS.length);
            expect(store.isOrgUnitRefreshExhausted(TENANT, ORG_A)).toBe(true);
            expect(console.warn).toHaveBeenCalled();
        });

        it("does nothing before there is an SDK store to ask", async () => {
            const store = new VerjiPermissionsStore(dispatcher);
            const timersBefore = jest.getTimerCount();

            store.requestOrgUnitRefresh(TENANT, ORG_A);

            expect(jest.getTimerCount()).toBe(timersBefore);
            expect(store.isOrgUnitRefreshExhausted(TENANT, ORG_A)).toBe(false);
        });

        describe("on logout or a user switch", () => {
            /** Switch the synced client to a second user, as the sync action does. */
            const switchUser = async (): Promise<void> => {
                const secondClient = getMockClientWithEventEmitter({
                    ...mockClientMethodsUser("@bob:domain.org"),
                    getAccessToken: jest.fn().mockReturnValue("macaroon-2"),
                });
                dispatcher.dispatch(
                    {
                        action: "MatrixActions.sync",
                        prevState: SyncState.Syncing,
                        state: SyncState.Prepared,
                        matrixClient: secondClient,
                    },
                    true,
                );
                await jest.advanceTimersByTimeAsync(0);
                expect(permissions.init).toHaveBeenCalledTimes(2);
            };

            it("cancels a pending attempt rather than leaving its timer behind", async () => {
                const store = await startedStore();
                const timersBefore = jest.getTimerCount();
                store.requestOrgUnitRefresh(TENANT, ORG_A);
                expect(jest.getTimerCount()).toBe(timersBefore + 1);

                dispatcher.dispatch({ action: Action.OnLoggedOut }, true);

                expect(jest.getTimerCount()).toBe(timersBefore);
                await jest.advanceTimersByTimeAsync(LONG_AFTER);
                expect(permissions.refreshContext).not.toHaveBeenCalled();
            });

            it("schedules nothing more when an attempt was in flight", async () => {
                const store = await startedStore();
                let land!: () => void;
                permissions.refreshContext.mockImplementation(() => new Promise<void>((resolve) => (land = resolve)));
                store.requestOrgUnitRefresh(TENANT, ORG_A);
                await jest.advanceTimersByTimeAsync(0);
                expect(permissions.refreshContext).toHaveBeenCalledTimes(1);

                dispatcher.dispatch({ action: Action.OnLoggedOut }, true);
                land();
                await jest.advanceTimersByTimeAsync(LONG_AFTER);

                expect(permissions.refreshContext).toHaveBeenCalledTimes(1);
                expect(store.isOrgUnitRefreshExhausted(TENANT, ORG_A)).toBe(false);
            });

            it("does not resume the first user's schedule under the next user", async () => {
                // The in-flight response lands after the second user's store is up, so the store
                // has an SDK store to ask again: only the voided schedule must stop it.
                const store = await startedStore();
                let land!: () => void;
                permissions.refreshContext.mockImplementationOnce(
                    () => new Promise<void>((resolve) => (land = resolve)),
                );
                store.requestOrgUnitRefresh(TENANT, ORG_A);
                await jest.advanceTimersByTimeAsync(0);
                expect(permissions.refreshContext).toHaveBeenCalledTimes(1);

                await switchUser();
                land();
                await jest.advanceTimersByTimeAsync(LONG_AFTER);

                expect(permissions.refreshContext).toHaveBeenCalledTimes(1);
                expect(store.isOrgUnitRefreshExhausted(TENANT, ORG_A)).toBe(false);
            });

            it("forgets used-up pairs, so the next user starts with a full budget", async () => {
                const store = await startedStore();
                store.requestOrgUnitRefresh(TENANT, ORG_A);
                await jest.advanceTimersByTimeAsync(LONG_AFTER);
                expect(store.isOrgUnitRefreshExhausted(TENANT, ORG_A)).toBe(true);

                await switchUser();

                expect(store.isOrgUnitRefreshExhausted(TENANT, ORG_A)).toBe(false);
                permissions.refreshContext.mockClear();
                store.requestOrgUnitRefresh(TENANT, ORG_A);
                await jest.advanceTimersByTimeAsync(0);
                expect(permissions.refreshContext).toHaveBeenCalledTimes(1);
            });
        });
    });

    /**
     * The backstop: while a gate reading a tenant is mounted, the tenant's copy is revalidated once
     * it is older than the SDK's TTL. That caps every other kind of staleness — a role granted or
     * revoked mid-session — at about the TTL, and it must not depend on anything re-rendering.
     */
    describe("watching a tenant", () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        it("revalidates a stale copy at once, and checks again on a timer with nothing re-rendering", async () => {
            const store = await startedStore();
            permissions.context.status = "stale";

            const unwatch = store.watchTenant(TENANT);
            expect(permissions.ensureContextFresh).toHaveBeenCalledTimes(1);
            expect(permissions.ensureContextFresh).toHaveBeenCalledWith(TENANT);

            // Revalidated. A fresh copy costs nothing, however long the gate stays mounted.
            permissions.context.status = "fresh";
            jest.advanceTimersByTime(10 * STALE_CHECK_INTERVAL_MS);
            expect(permissions.ensureContextFresh).toHaveBeenCalledTimes(1);

            // Past the TTL again: the next check catches it, with no render involved.
            permissions.context.status = "stale";
            jest.advanceTimersByTime(STALE_CHECK_INTERVAL_MS);
            expect(permissions.ensureContextFresh).toHaveBeenCalledTimes(2);

            unwatch();
        });

        it("asks at most once per throttle window while a copy stays stale", async () => {
            // Say every revalidation fails, so the copy never turns fresh, and gates keep mounting.
            const store = await startedStore();
            permissions.context.status = "stale";

            const unwatchFirst = store.watchTenant(TENANT);
            jest.advanceTimersByTime(STALE_REVALIDATION_THROTTLE_MS - 1);
            const unwatchSecond = store.watchTenant(TENANT);
            expect(permissions.ensureContextFresh).toHaveBeenCalledTimes(1);

            jest.advanceTimersByTime(1);
            store.watchTenant(TENANT)();
            expect(permissions.ensureContextFresh).toHaveBeenCalledTimes(2);

            unwatchFirst();
            unwatchSecond();
        });

        it("stops checking once the last gate reading the tenant unmounts", async () => {
            const store = await startedStore();
            const timersBefore = jest.getTimerCount();
            const unwatchFirst = store.watchTenant(TENANT);
            const unwatchSecond = store.watchTenant(TENANT);
            expect(jest.getTimerCount()).toBe(timersBefore + 1);

            unwatchFirst();
            unwatchFirst(); // a second call must not count the other gate out
            permissions.context.status = "stale";
            jest.advanceTimersByTime(STALE_CHECK_INTERVAL_MS);
            expect(permissions.ensureContextFresh).toHaveBeenCalledTimes(1);

            unwatchSecond();
            expect(jest.getTimerCount()).toBe(timersBefore);
            jest.advanceTimersByTime(10 * STALE_CHECK_INTERVAL_MS);
            expect(permissions.ensureContextFresh).toHaveBeenCalledTimes(1);
        });

        it("leaves a tenant with no copy alone, so a cold cache stays outside the beta", async () => {
            const store = await startedStore();

            const unwatch = store.watchTenant("tenant-2");
            jest.advanceTimersByTime(10 * STALE_CHECK_INTERVAL_MS);

            expect(permissions.ensureContextFresh).not.toHaveBeenCalled();
            unwatch();
        });

        it("does nothing before there is an SDK store to ask", () => {
            permissions.context.status = "stale";

            const unwatch = new VerjiPermissionsStore(dispatcher).watchTenant(TENANT);
            jest.advanceTimersByTime(10 * STALE_CHECK_INTERVAL_MS);

            expect(permissions.ensureContextFresh).not.toHaveBeenCalled();
            unwatch();
        });

        it("starts the next user with a fresh throttle", async () => {
            const store = await startedStore();
            permissions.context.status = "stale";
            const unwatch = store.watchTenant(TENANT);
            expect(permissions.ensureContextFresh).toHaveBeenCalledTimes(1);

            dispatcher.dispatch(
                {
                    action: "MatrixActions.sync",
                    prevState: SyncState.Syncing,
                    state: SyncState.Prepared,
                    matrixClient: getMockClientWithEventEmitter({
                        ...mockClientMethodsUser("@bob:domain.org"),
                        getAccessToken: jest.fn().mockReturnValue("macaroon-2"),
                    }),
                },
                true,
            );
            await jest.advanceTimersByTimeAsync(0);
            // Well inside the first user's throttle window: a gate mounting for the new user asks.
            store.watchTenant(TENANT)();

            expect(permissions.ensureContextFresh).toHaveBeenCalledTimes(2);
            unwatch();
        });
    });
});
