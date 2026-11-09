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

import { MatrixClient, Room } from "matrix-js-sdk/src/matrix";
import { KnownMembership, Membership } from "matrix-js-sdk/src/types";
import { mocked } from "jest-mock";
import { getVerjiApiSdk } from "@verji/verji-api-sdk/lib/asyncInit";
import { OrgUnitRoomConflictError } from "@verji/verji-api-sdk";

import {
    assignDefaultOrgUnitCategory,
    assignRoomToOrgUnit,
    describeError,
    findOrgUnitSpace,
    forgetHasOrgUnitWithoutCategory,
    getConflictReason,
    getOrgUnitName,
    getOrgUnitRoomCandidates,
    getOrgUnitsWithoutCategory,
    isForbidden,
    isOrganizationApiConfigured,
    knownHasOrgUnitWithoutCategory,
    rememberHasOrgUnitWithoutCategory,
} from "../../../src/stores/verji/verjiOrgUnitRooms";
import SdkConfig from "../../../src/SdkConfig";
import { VerjiRoleReader } from "../../../src/stores/verji/verjiRoles";
import { mkEvent, mockStateEventImplementation } from "../../test-utils";

// VERJI: verji/verji-src#2117
jest.mock("@verji/verji-api-sdk/lib/asyncInit", () => ({ getVerjiApiSdk: jest.fn() }));

const TOKEN = { access_token: "verji-token" };

describe("verjiOrgUnitRooms", () => {
    const client = { getAccessToken: () => "macaroon" } as unknown as MatrixClient;
    const getAccessToken = jest.fn();
    const organization = {
        getOrgUnits: jest.fn(),
        assignDefaultOrgUnitCategory: jest.fn(),
        getOrgUnitRoomCandidates: jest.fn(),
        assignRoomToOrgUnit: jest.fn(),
    };

    const sdkWith = (organizationService: unknown): void => {
        mocked(getVerjiApiSdk).mockResolvedValue({
            api: { identityService: { getAccessToken }, organizationService },
        } as never);
    };

    beforeEach(() => {
        jest.resetAllMocks();
        getAccessToken.mockResolvedValue(TOKEN);
        sdkWith(organization);
    });

    /** A reader of t1's access context with these grants; it knows nothing of any other tenant. */
    const rolesFor = (grants: Record<string, string[]>): VerjiRoleReader => ({
        hasRole: (tenantId, roleName, instanceId) => tenantId === "t1" && (grants[roleName] ?? []).includes(instanceId),
        isInstanceReferenced: () => false,
        getRoleInstances: (tenantId, roleName) => (tenantId === "t1" ? grants[roleName] ?? [] : []),
    });
    const PRIMARY_CONTACT = rolesFor({ "Customer-Manager#": ["t1"] });

    it("lists only the org units that have no category, with a token minted from the client's macaroon", async () => {
        organization.getOrgUnits.mockResolvedValue({
            results: [
                { id: "u1", name: "In already", orgUnitCategoryId: "cat-1" },
                { id: "u2", name: "From before", orgUnitCategoryId: null },
            ],
        });

        await expect(getOrgUnitsWithoutCategory(client, "t1", PRIMARY_CONTACT)).resolves.toEqual([
            { id: "u2", name: "From before", orgUnitCategoryId: null },
        ]);
        expect(getAccessToken).toHaveBeenCalledWith("macaroon");
        expect(organization.getOrgUnits).toHaveBeenCalledWith(TOKEN, "t1");
    });

    // VERJI: verji/verji-src#2117 — the tenant's PrimaryContact brings in any, an Owner their own.
    it.each([
        ["the tenant's PrimaryContact, every one", PRIMARY_CONTACT, ["u2", "u3"]],
        ["an Owner, their own", rolesFor({ "ClientOrganization-Owner": ["u3", "u1"] }), ["u3"]],
        ["the org unit's own PrimaryContact, none", rolesFor({ "ClientOrganization-Manager#": ["u2"] }), []],
        ["a StandardUser who owns nothing, none", rolesFor({ "Customer-User#": ["t1"] }), []],
    ])("lists %s", async (_who, roles, expected) => {
        organization.getOrgUnits.mockResolvedValue({
            results: [
                { id: "u1", name: "In already", orgUnitCategoryId: "cat-1" },
                { id: "u2", name: "From before", orgUnitCategoryId: null },
                { id: "u3", name: "Also from before", orgUnitCategoryId: null },
            ],
        });

        const listed = await getOrgUnitsWithoutCategory(client, "t1", roles);

        expect(listed.map((orgUnit) => orgUnit.id)).toEqual(expected);
    });

    it("passes the tenant, the org unit and the room on to the Organization API", async () => {
        organization.getOrgUnitRoomCandidates.mockResolvedValue({ results: [] });

        await assignDefaultOrgUnitCategory(client, "t1", "u1");
        await getOrgUnitRoomCandidates(client, "t1", "u1");
        await assignRoomToOrgUnit(client, "t1", "u1", "!r:server");

        expect(organization.assignDefaultOrgUnitCategory).toHaveBeenCalledWith(TOKEN, "t1", "u1");
        expect(organization.getOrgUnitRoomCandidates).toHaveBeenCalledWith(TOKEN, "t1", "u1");
        expect(organization.assignRoomToOrgUnit).toHaveBeenCalledWith(TOKEN, "t1", "u1", "!r:server");
    });

    it("fails clearly when the Organization API is not configured", async () => {
        sdkWith(undefined);

        await expect(getOrgUnitsWithoutCategory(client, "t1", PRIMARY_CONTACT)).rejects.toThrow("verjiOrganizationUrl");
    });

    describe("isOrganizationApiConfigured", () => {
        afterEach(() => SdkConfig.reset());

        it("answers whether the config the SDK is created from names the Organization API", () => {
            SdkConfig.put({ verjiItopsUrl: "https://itops.test", verjiOrganizationUrl: "https://org.test" } as never);
            expect(isOrganizationApiConfigured()).toBe(true);

            SdkConfig.put({ verjiItopsUrl: "https://itops.test" } as never);
            expect(isOrganizationApiConfigured()).toBe(false);

            SdkConfig.put({ verjiItopsUrl: "https://itops.test", verjiOrganizationUrl: "" } as never);
            expect(isOrganizationApiConfigured()).toBe(false);
        });
    });

    describe("findOrgUnitSpace", () => {
        /** A space carrying the Verji state a guest org's personal space carries, sent by vsys unless `sender` says. */
        const makeSpace = (
            roomId: string,
            membership: Membership,
            tenantId = "t1",
            orgUnitId = "u1",
            sender = "@vsys:server",
        ): Room => {
            const state = [
                mkEvent({
                    event: true,
                    type: "app.verji.tenant_info",
                    skey: "app.verji.tenant_info",
                    room: roomId,
                    user: sender,
                    content: { tenant_id: tenantId },
                }),
                mkEvent({
                    event: true,
                    type: "app.verji.org_unit_info",
                    skey: "app.verji.org_unit_info",
                    room: roomId,
                    user: sender,
                    content: { org_unit_id: orgUnitId },
                }),
            ];
            return {
                roomId,
                client: { getDomain: () => "server" },
                isSpaceRoom: () => true,
                getMyMembership: () => membership,
                currentState: { getStateEvents: jest.fn().mockImplementation(mockStateEventImplementation(state)) },
            } as unknown as Room;
        };
        const withRooms = (rooms: Room[]): MatrixClient => ({ getRooms: () => rooms }) as unknown as MatrixClient;

        it("finds the space of the tenant's org unit the client has joined", () => {
            const joined = makeSpace("!joined:server", KnownMembership.Join);
            const rooms = [
                makeSpace("!other-org:server", KnownMembership.Join, "t1", "u2"),
                makeSpace("!other-tenant:server", KnownMembership.Join, "t2", "u1"),
                joined,
            ];

            expect(findOrgUnitSpace(withRooms(rooms), "t1", "u1")).toBe(joined);
            expect(findOrgUnitSpace(withRooms(rooms.slice(0, 2)), "t1", "u1")).toBeNull();
        });

        it.each([KnownMembership.Invite, KnownMembership.Leave])("passes over a space the client is %s in", (mship) => {
            expect(findOrgUnitSpace(withRooms([makeSpace("!space:server", mship)]), "t1", "u1")).toBeNull();
        });

        it("passes over a space whose Verji events someone other than vsys sent: anyone may stamp a space of their own", () => {
            const forged = makeSpace("!forged:server", KnownMembership.Join, "t1", "u1", "@mallory:server");
            const ours = makeSpace("!ours:server", KnownMembership.Join);

            expect(findOrgUnitSpace(withRooms([forged]), "t1", "u1")).toBeNull();
            expect(findOrgUnitSpace(withRooms([forged, ours]), "t1", "u1")).toBe(ours);
        });
    });

    describe("the org unit's own name", () => {
        it("is the name the Organization API lists it under", async () => {
            organization.getOrgUnits.mockResolvedValue({
                results: [
                    { id: "u1", name: "Kari AS", orgUnitCategoryId: "cat-1" },
                    { id: "u2", name: "Ola AS", orgUnitCategoryId: null },
                ],
            });

            await expect(getOrgUnitName(client, "t1", "u2")).resolves.toBe("Ola AS");
            expect(organization.getOrgUnits).toHaveBeenCalledWith(TOKEN, "t1");
        });

        it("is unknown when the Organization API does not list the org unit", async () => {
            organization.getOrgUnits.mockResolvedValue({
                results: [{ id: "u1", name: "Kari AS", orgUnitCategoryId: null }],
            });

            await expect(getOrgUnitName(client, "t1", "u9")).resolves.toBeUndefined();
        });
    });

    describe("whether the user has an org unit to bring in, as last answered", () => {
        afterEach(() => forgetHasOrgUnitWithoutCategory());

        it("is kept per tenant, and holds only under the access context it was asked under", () => {
            rememberHasOrgUnitWithoutCategory("t1", 7, true);
            rememberHasOrgUnitWithoutCategory("t2", 7, false);

            expect(knownHasOrgUnitWithoutCategory("t1", 7)).toBe(true);
            expect(knownHasOrgUnitWithoutCategory("t2", 7)).toBe(false);
            expect(knownHasOrgUnitWithoutCategory("t3", 7)).toBeUndefined();
            // The access context changed: the user's org units may have too.
            expect(knownHasOrgUnitWithoutCategory("t1", 8)).toBeUndefined();
        });

        it("is forgotten for one tenant once a guest org is brought in, or for all", () => {
            rememberHasOrgUnitWithoutCategory("t1", 7, true);
            rememberHasOrgUnitWithoutCategory("t2", 7, true);

            forgetHasOrgUnitWithoutCategory("t1");
            expect(knownHasOrgUnitWithoutCategory("t1", 7)).toBeUndefined();
            expect(knownHasOrgUnitWithoutCategory("t2", 7)).toBe(true);

            forgetHasOrgUnitWithoutCategory();
            expect(knownHasOrgUnitWithoutCategory("t2", 7)).toBeUndefined();
        });
    });

    it("reads a 403 off the error's HTTP status: the user may no longer do this", () => {
        // What the SDK passes on for a 403: the request's own error.
        const forbidden = Object.assign(new Error("Request failed with status code 403"), {
            name: "AxiosError",
            response: { status: 403 },
        });

        expect(isForbidden(forbidden)).toBe(true);
        expect(isForbidden({ response: { status: 403 } })).toBe(true);
        for (const other of [
            Object.assign(new Error("x"), { response: { status: 409 } }),
            Object.assign(new Error("x"), { response: { status: 500 } }),
            Object.assign(new Error("x"), { response: { status: "403" } }),
            new OrgUnitRoomConflictError("MemberOutsideOrgUnit"),
            new Error("down"),
            "403",
            null,
            undefined,
        ]) {
            expect(isForbidden(other)).toBe(false);
        }
    });

    it("reads a conflict's reason, and nothing from any other failure", () => {
        expect(getConflictReason(new OrgUnitRoomConflictError("MemberOutsideOrgUnit"))).toBe("MemberOutsideOrgUnit");
        expect(getConflictReason(new OrgUnitRoomConflictError(undefined))).toBeUndefined();
        expect(getConflictReason(new Error("down"))).toBeNull();
        expect(getConflictReason("down")).toBeNull();
    });

    it("reads a conflict whose reason is not text as one without a reason", () => {
        // A second copy of the SDK, or a changed one, could carry anything there: only text is a reason.
        for (const reason of [42, { reason: "MemberOutsideOrgUnit" }, ["NotARoom"], true, null]) {
            const conflict = Object.assign(new Error("conflict"), { name: "OrgUnitRoomConflictError", reason });
            expect(getConflictReason(conflict)).toBeUndefined();
        }
    });

    it("logs a failure as its message, never with the request that carries the token", () => {
        const failure = Object.assign(new Error("Request failed with status code 403"), {
            name: "AxiosError",
            config: { headers: { Authorization: "Bearer verji-token" } },
        });

        expect(describeError(failure)).toBe("AxiosError: Request failed with status code 403");
        expect(describeError("plain")).toBe("plain");
    });
});
