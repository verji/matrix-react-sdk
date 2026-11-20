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
import { act, render } from "@testing-library/react";
import { MatrixClient, Room } from "matrix-js-sdk/src/matrix";
import { mocked } from "jest-mock";

import { mkEvent, mockStateEventImplementation } from "../test-utils";
import SdkConfig from "../../src/SdkConfig";
import { VerjiPermissionsStore } from "../../src/stores/verji/VerjiPermissionsStore";
import { useVerjiGate } from "../../src/hooks/useVerjiPermissions";
import { getAddExistingGuestOrgGate, isGateOffered } from "../../src/stores/verji/verjiGates";
import { useHasOrgUnitWithoutCategory } from "../../src/hooks/useHasOrgUnitWithoutCategory";
import {
    askHasOrgUnitWithoutCategory,
    currentSignedInUser,
    forgetHasOrgUnitWithoutCategory,
    getOrgUnitsWithoutCategory,
    isOrganizationApiConfigured,
    knownHasOrgUnitWithoutCategory,
    markBringingIn,
    setSignedInUser,
} from "../../src/stores/verji/verjiOrgUnitRooms";

// VERJI: verji/verji-src#2117 — the Organization API call is mocked; the answers it feeds are not.
jest.mock("../../src/stores/verji/verjiOrgUnitRooms", () => ({
    ...jest.requireActual("../../src/stores/verji/verjiOrgUnitRooms"),
    getOrgUnitsWithoutCategory: jest.fn(),
}));

const TENANT = "tenant-1";
const ORG_A = "org-a";
const ORG_B = "org-b";
const USER = "@alice:server";

/** What SpaceContextMenu computes for "Add existing Guest Organization". */
const Menu: React.FC<{ space: Room }> = ({ space }) => {
    const organizationApi = isOrganizationApiConfigured();
    const gate = useVerjiGate(space, getAddExistingGuestOrgGate);
    const has = useHasOrgUnitWithoutCategory(space, organizationApi && isGateOffered(gate));
    return <div data-testid="has">{String(has)}</div>;
};

describe("useHasOrgUnitWithoutCategory", () => {
    const client = { getDomain: () => "server", getUserId: () => USER } as unknown as MatrixClient;
    const state = [
        mkEvent({
            event: true,
            type: "app.verji.tenant_info",
            skey: "app.verji.tenant_info",
            room: "!root:server",
            user: "@vsys:server",
            content: { tenant_id: TENANT },
        }),
    ];
    const space = {
        roomId: "!root:server",
        name: "Acme AS",
        client,
        isSpaceRoom: () => true,
        getMyMembership: () => "join",
        currentState: { getStateEvents: jest.fn().mockImplementation(mockStateEventImplementation(state)) },
    } as unknown as Room;
    // The Owner of two guest orgs, who is not the tenant's PrimaryContact: her menu asks.
    const grants = { "Customer-User#": [TENANT], "ClientOrganization-Owner": [ORG_A, ORG_B] };
    const store = VerjiPermissionsStore.instance as unknown as {
        permissions: unknown;
        getVersion(): number;
        bumpVersion(): void;
        onNotReady(): Promise<void>;
    };

    beforeEach(() => {
        SdkConfig.put({ verjiItopsUrl: "https://itops.test", verjiOrganizationUrl: "https://org.test" } as never);
        store.permissions = {
            isCanonicalSpaceSyncEnabled: (tenantId: string) => tenantId === TENANT,
            isJoinExistingOrgUnitsAndRoomsEnabled: (tenantId: string) => tenantId === TENANT,
            hasRole: (tenantId: string, roleName: string, instanceId: string) =>
                tenantId === TENANT && ((grants as Record<string, string[]>)[roleName] ?? []).includes(instanceId),
            peekContext: () => ({ status: "fresh", record: { roles: grants } }),
            refreshContext: jest.fn().mockResolvedValue(undefined),
            ensureContextFresh: jest.fn().mockResolvedValue(undefined),
            clearAll: jest.fn().mockResolvedValue(undefined),
            dispose: jest.fn(),
        };
        forgetHasOrgUnitWithoutCategory();
        // VerjiPermissionsStore.onReady's first step, for her.
        setSignedInUser(USER);
        // The Organization API still lists ORG_B without a category: its bring-in is settling.
        mocked(getOrgUnitsWithoutCategory).mockResolvedValue([{ id: ORG_B, name: "Ola AS", orgUnitCategoryId: null }]);
    });

    afterEach(() => {
        store.permissions = undefined;
        SdkConfig.reset();
    });

    /** She brings ORG_B in with a menu open, her session is soft-logged-out, and she signs in again. */
    const softLogoutAndBack = async (accessContextChangedJustBefore: boolean): Promise<void> => {
        // 202 a minute ago, and ORG_B's space has not arrived.
        markBringingIn(TENANT, ORG_B, currentSignedInUser());
        const { unmount } = render(<Menu space={space} />);
        await act(async () => {
            await Promise.resolve();
        });

        if (accessContextChangedJustBefore) {
            // The SDK says her access context changed. React 17 renders the menu at once, outside any
            // batch, and leaves the hook's effect for the new version to the scheduler.
            store.bumpVersion();
        }
        // Before the scheduler runs it, the soft logout reaches onNotReady, whose version bump runs it.
        await store.onNotReady();
        // She signs in again in the same tab: onReady's first step.
        setSignedInUser(USER);
        store.permissions = undefined;
        unmount();
    };

    it("keeps the user's bring-in that is still settling over a soft logout", async () => {
        await softLogoutAndBack(false);

        const version = store.getVersion();
        await askHasOrgUnitWithoutCategory(TENANT, version, async () => true);
        expect(knownHasOrgUnitWithoutCategory(TENANT, version)).toBeUndefined();
    });

    it("keeps it too when her access context changed just before the soft logout, with a menu open", async () => {
        await softLogoutAndBack(true);

        const version = store.getVersion();
        await askHasOrgUnitWithoutCategory(TENANT, version, async () => true);
        expect(knownHasOrgUnitWithoutCategory(TENANT, version)).toBeUndefined();
    });
});
