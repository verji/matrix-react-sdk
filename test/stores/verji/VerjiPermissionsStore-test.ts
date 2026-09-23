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
import { VerjiPermissionsStore } from "../../../src/stores/verji/VerjiPermissionsStore";
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

/**
 * A stand-in for `sdk.permissions` that knows TENANT: the rollout switch is on there and the user
 * is a StandardUser of it. Everything else reads as unknown, as the real store answers.
 */
const makePermissions = () => {
    const listeners = new Set<PermissionChangeListener>();
    const unsubscribe = jest.fn();
    return {
        init: jest.fn().mockResolvedValue(undefined),
        isCanonicalSpaceSyncEnabled: jest.fn((tenantId: string) => tenantId === TENANT),
        hasRole: jest.fn(
            (tenantId: string, roleName: string, instanceId: string) =>
                tenantId === TENANT && roleName === "Customer-User#" && instanceId === TENANT,
        ),
        peekContext: jest.fn((tenantId: string) => ({ status: tenantId === TENANT ? "fresh" : "missing" })),
        ensureContextFresh: jest.fn().mockResolvedValue(undefined),
        subscribe: jest.fn((listener: PermissionChangeListener) => {
            listeners.add(listener);
            return unsubscribe;
        }),
        clearAll: jest.fn().mockResolvedValue(undefined),
        dispose: jest.fn(),
        /** Test hook: emit a change the way the SDK store does. */
        emit: (): void => listeners.forEach((listener) => listener({ type: "contextUpdated", tenantId: TENANT })),
        unsubscribe,
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
            expect(store.peekContext(TENANT)).toEqual({ status: "fresh" });
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
});
