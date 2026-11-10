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

import { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk/src/matrix";

import SettingsStore from "../../../src/settings/SettingsStore";
import { UIFeature } from "../../../src/settings/UIFeature";
import SpaceStore from "../../../src/stores/spaces/SpaceStore";
import { VerjiPermissionsStore } from "../../../src/stores/verji/VerjiPermissionsStore";
import { VerjiGateVerdict } from "../../../src/stores/verji/verjiGates";
import {
    isVerjiGuestOrgOnboardingEnabled,
    resolveVerjiOnboardingTarget,
} from "../../../src/stores/verji/verjiOnboardingTarget";
import { getMockClientWithEventEmitter, mockClientMethodsUser } from "../../test-utils";

const USER = "@alice:domain.org";
const TENANT = "tenant-1";
const ORG_A = "org-a";

/** A real Room with real Verji state events, which key on their own type. */
const makeSpace = (client: MatrixClient, events: Record<string, object>, roomId: string, name: string): Room => {
    const room = new Room(roomId, client, USER);
    room.name = name;
    jest.spyOn(room, "isSpaceRoom").mockReturnValue(true);
    room.currentState.setStateEvents(
        Object.entries(events).map(
            ([type, content]) =>
                new MatrixEvent({ type, state_key: type, room_id: room.roomId, sender: USER, content }),
        ),
    );
    return room;
};

describe("verjiOnboardingTarget", () => {
    let client: MatrixClient;
    let tenantRoot: Room;
    let orgUnitSpace: Room;
    let flagOn: boolean;

    /** The rollout is on for TENANT, and the user holds `grants` there. */
    const givenRoles = (grants: Record<string, string[]>): void => {
        const store = VerjiPermissionsStore.instance;
        jest.spyOn(store, "isCanonicalSpaceSyncEnabled").mockImplementation((tenantId) => tenantId === TENANT);
        jest.spyOn(store, "hasRole").mockImplementation(
            (tenantId, role, instance) => tenantId === TENANT && (grants[role] ?? []).includes(instance),
        );
        jest.spyOn(store, "isInstanceReferenced").mockImplementation(
            (tenantId, instance) => tenantId === TENANT && Object.values(grants).some((i) => i.includes(instance)),
        );
        jest.spyOn(store, "isOrgUnitRefreshExhausted").mockReturnValue(false);
    };

    beforeEach(() => {
        client = getMockClientWithEventEmitter(mockClientMethodsUser(USER));
        tenantRoot = makeSpace(
            client,
            { "app.verji.tenant_info": { tenant_id: TENANT } },
            "!root:domain.org",
            "Acme AS",
        );
        orgUnitSpace = makeSpace(
            client,
            {
                "app.verji.tenant_info": { tenant_id: TENANT },
                "app.verji.org_unit_info": { org_unit_id: ORG_A, org_unit_name: "Org A" },
                "app.verji.canonical_parent_space": { canonical_parent_space_id: "!parent:domain.org" },
            },
            "!org-a:domain.org",
            "Org A (personal)",
        );
        jest.spyOn(SpaceStore.instance, "spacePanelSpaces", "get").mockReturnValue([tenantRoot]);

        flagOn = true;
        jest.spyOn(SettingsStore, "getValue").mockImplementation((name: string) =>
            name === UIFeature.VerjiGuestOrgOnboarding ? flagOn : undefined,
        );
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("reads the flag", () => {
        expect(isVerjiGuestOrgOnboardingEnabled()).toBe(true);
        flagOn = false;
        expect(isVerjiGuestOrgOnboardingEnabled()).toBe(false);
    });

    it("is null outside a Verji space, so the dialog behaves as it always has", () => {
        const plainSpace = makeSpace(client, {}, "!plain:domain.org", "Plain");

        expect(resolveVerjiOnboardingTarget(plainSpace)).toBeNull();
        expect(resolveVerjiOnboardingTarget(null)).toBeNull();
    });

    it("names the guest org in a guest org's space, with the onboard gate's decision", () => {
        givenRoles({ "Customer-User#": [TENANT], "ClientOrganization-Owner": [ORG_A] });

        expect(resolveVerjiOnboardingTarget(orgUnitSpace)).toEqual({
            tenantId: TENANT,
            tenantName: "Acme AS",
            guestOrganizationId: ORG_A,
            guestOrganizationName: "Org A",
            decision: { verdict: VerjiGateVerdict.Allowed },
        });
    });

    it("carries the denial for a Member, so the dialog refuses what the button would", () => {
        givenRoles({ "Customer-User#": [TENANT], "ClientOrganization-User#": [ORG_A] });

        const target = resolveVerjiOnboardingTarget(orgUnitSpace)!;

        expect(target.guestOrganizationId).toBe(ORG_A);
        expect(target.decision.verdict).toBe(VerjiGateVerdict.Denied);
    });

    it("names no guest org at the tenant's root space", () => {
        givenRoles({ "Customer-User#": [TENANT] });

        const target = resolveVerjiOnboardingTarget(tenantRoot)!;

        expect(target.tenantId).toBe(TENANT);
        expect(target.guestOrganizationId).toBeUndefined();
        expect(target.decision.verdict).toBe(VerjiGateVerdict.Allowed);
    });

    it("names no guest org with the flag off, and decides on the tenant rule", () => {
        // A Member: denied by the onboard gate, allowed by the tenant rule
        flagOn = false;
        givenRoles({ "Customer-User#": [TENANT], "ClientOrganization-User#": [ORG_A] });

        const target = resolveVerjiOnboardingTarget(orgUnitSpace)!;

        expect(target.guestOrganizationId).toBeUndefined();
        expect(target.guestOrganizationName).toBeUndefined();
        expect(target.decision.verdict).toBe(VerjiGateVerdict.Allowed);
    });
});
