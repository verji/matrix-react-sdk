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

import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { mocked } from "jest-mock";
import { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk/src/matrix";
import { getVerjiApiSdk, initVerjiApiSdkAsync } from "@verji/verji-api-sdk/lib/asyncInit";
import { createPermissionStore, PermissionPersistence } from "@verji/verji-api-sdk/lib/permissions";

import type { PermissionStore } from "@verji/verji-api-sdk";
import type { AcContextResponse } from "@verji/verji-api-sdk/lib/services/itopsService/types";
import { useVerjiGate } from "../../src/hooks/useVerjiPermissions";
import SpaceStore from "../../src/stores/spaces/SpaceStore";
import { VerjiPermissionsStore } from "../../src/stores/verji/VerjiPermissionsStore";
import { getCreateRoomGate, VerjiGateVerdict } from "../../src/stores/verji/verjiGates";
import SdkConfig from "../../src/SdkConfig";
import { getMockClientWithEventEmitter, mockClientMethodsUser } from "../test-utils";

jest.mock("@verji/verji-api-sdk/lib/asyncInit", () => ({
    initVerjiApiSdkAsync: jest.fn(),
    getVerjiApiSdk: jest.fn(),
}));

const USER = "@alice:domain.org";
const TENANT = "tenant-1";
const ORG = "org-new";
const STANDARD_USER = { "Customer-User#": [TENANT] };

/** The SDK's IndexedDB persistence, minus IndexedDB: these tests are about memory, events and time. */
const noPersistence = (): PermissionPersistence => ({
    open: async () => {},
    isEnabled: () => false,
    readOwner: async () => undefined,
    writeOwner: async () => {},
    clearOwner: async () => {},
    loadAll: async () => [],
    put: async () => {},
    deleteRecord: async () => {},
    loadAllContexts: async () => [],
    putContext: async () => {},
    deleteContext: async () => {},
    clearTenant: async () => {},
    clearAllRecords: async () => {},
    close: () => {},
});

/**
 * verji/verji-src#1507 over time, with nothing stubbed between the gate and the network: the real
 * hook and create-room gate read the real bridge store, which reads a real SDK access-context cache
 * fed by a fake itops, on fake timers. The space is a guest org created after page load, so the
 * page-load copy of the context has never heard of it.
 *
 * Nothing here re-renders the gate from outside. A room list whose sublists skip updates gives the
 * "+" no renders of its own, so whatever settles the gate has to come from the store.
 */
describe("useVerjiGate over time, on the create-room gate", () => {
    /** What itops would answer now. Tests change it to play the backend writing or removing a row. */
    let serverRoles: Record<string, string[]>;
    let contextFetcher: jest.Mock<Promise<AcContextResponse>, [unknown, string]>;
    let sdkPermissions: PermissionStore;
    let space: Room;
    /** Every verdict the gate rendered, in order. */
    let verdicts: VerjiGateVerdict[];

    const Probe: React.FC<{ space: Room }> = ({ space }) => {
        verdicts.push(useVerjiGate(space, getCreateRoomGate).verdict);
        return null;
    };
    const current = (): VerjiGateVerdict => verdicts[verdicts.length - 1];
    const advance = async (ms: number): Promise<void> => {
        await act(async () => {
            await jest.advanceTimersByTimeAsync(ms);
        });
    };

    beforeEach(async () => {
        jest.useFakeTimers();
        verdicts = [];
        const client = getMockClientWithEventEmitter(mockClientMethodsUser(USER));
        jest.spyOn(SpaceStore.instance, "spacePanelSpaces", "get").mockReturnValue([]);
        jest.spyOn(console, "warn").mockImplementation(() => {});

        space = new Room("!guest-org:domain.org", client, USER);
        jest.spyOn(space, "isSpaceRoom").mockReturnValue(true);
        space.currentState.setStateEvents(
            Object.entries({
                "app.verji.tenant_info": { tenant_id: TENANT },
                "app.verji.org_unit_info": { org_unit_id: ORG },
                "app.verji.canonical_parent_space": { canonical_parent_space_id: "!category:domain.org" },
            }).map(
                ([type, content]) =>
                    new MatrixEvent({ type, state_key: type, room_id: space.roomId, sender: USER, content }),
            ),
        );

        serverRoles = { ...STANDARD_USER };
        contextFetcher = jest.fn(
            async (_token: unknown, tenantId: string): Promise<AcContextResponse> => ({
                userId: USER,
                tenantId,
                aclDomain: tenantId,
                isSuperuser: false,
                canonicalSpaceSyncEnabled: true,
                roles: Object.entries(serverRoles).map(([name, instances]) => ({ name, instances: [...instances] })),
            }),
        );
        sdkPermissions = createPermissionStore(jest.fn(), contextFetcher, { persistence: noPersistence() });

        SdkConfig.put({ verjiItopsUrl: "https://itops.test" } as never);
        mocked(initVerjiApiSdkAsync).mockResolvedValue(undefined as never);
        mocked(getVerjiApiSdk).mockResolvedValue({
            permissions: sdkPermissions,
            api: { identityService: { getAccessToken: jest.fn().mockResolvedValue("verji-access-token") } },
        } as never);

        // The store's own init path, as on login. It reads only these two off the client.
        const store = VerjiPermissionsStore.instance;
        store.useUnitTestClient({ getUserId: () => USER, getAccessToken: () => "macaroon" } as unknown as MatrixClient);
        await store["onReady"]();
        // The page-load fetch, from before the guest org existed.
        await sdkPermissions.ensureContextFresh(TENANT);
    });

    afterEach(async () => {
        // Unmount first, so tearing the store down does not re-render a gate outside act().
        cleanup();
        await VerjiPermissionsStore.instance["onNotReady"]();
        VerjiPermissionsStore.instance["matrixClient"] = null;
        SdkConfig.reset();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it("finds an Owner row that lands 50 s after the space appears, as before #1495", async () => {
        render(<Probe space={space} />);
        expect(current()).toBe(VerjiGateVerdict.Checking);

        await advance(50_000);
        expect(current()).toBe(VerjiGateVerdict.Checking);
        serverRoles = { ...STANDARD_USER, "ClientOrganization-Owner": [ORG] };

        // The last attempt of the schedule, at about 67 s, brings it in.
        await advance(20_000);
        expect(current()).toBe(VerjiGateVerdict.Allowed);
    });

    it("settles a quiet tab within about the TTL when the Owner row lands after the schedule", async () => {
        render(<Probe space={space} />);
        await advance(70_000);
        expect(current()).toBe(VerjiGateVerdict.Denied);
        const fetchesWhenSettled = contextFetcher.mock.calls.length;

        // A tenant refresh slower than the schedule: the row lands just after it gave up.
        serverRoles = { ...STANDARD_USER, "ClientOrganization-Owner": [ORG] };

        // The copy the last attempt fetched goes stale five minutes on, and the watch catches it
        // with no render from outside.
        await advance(6 * 60_000);
        expect(current()).toBe(VerjiGateVerdict.Allowed);
        expect(contextFetcher.mock.calls.length).toBe(fetchesWhenSettled + 1);
    });

    it("costs one request per TTL in a quiet tab once settled, not one per check", async () => {
        render(<Probe space={space} />);
        await advance(70_000);
        expect(current()).toBe(VerjiGateVerdict.Denied);
        const fetchesWhenSettled = contextFetcher.mock.calls.length;

        await advance(30 * 60_000);

        // Thirty minutes at a five-minute TTL: about six revalidations, never one per 30 s check.
        expect(contextFetcher.mock.calls.length - fetchesWhenSettled).toBeLessThanOrEqual(6);
        expect(current()).toBe(VerjiGateVerdict.Denied);
    });

    it("settles on Denied, never back at Checking, when an OrgUnit it found later drops out", async () => {
        render(<Probe space={space} />);
        expect(current()).toBe(VerjiGateVerdict.Checking);

        // The first re-fetch finds the org through a room the user joined there.
        serverRoles = { ...STANDARD_USER, "ClientOrganization-SmsRoomMember": [ORG] };
        await advance(0);
        expect(current()).toBe(VerjiGateVerdict.Denied);
        const settledAt = verdicts.length - 1;

        // They leave their last room there; past the TTL the watch revalidates and the row is gone.
        serverRoles = { ...STANDARD_USER };
        await advance(6 * 60_000);
        expect(sdkPermissions.peekContext(TENANT).record?.roles["ClientOrganization-SmsRoomMember"]).toBeUndefined();

        expect(current()).toBe(VerjiGateVerdict.Denied);
        expect(verdicts.slice(settledAt)).not.toContain(VerjiGateVerdict.Checking);
    });
});
