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
    getConflictReason,
    getOrgUnitRoomCandidates,
    getOrgUnitsWithoutCategory,
    isOrganizationApiConfigured,
} from "../../../src/stores/verji/verjiOrgUnitRooms";
import SdkConfig from "../../../src/SdkConfig";
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

    it("lists only the org units that have no category, with a token minted from the client's macaroon", async () => {
        organization.getOrgUnits.mockResolvedValue({
            results: [
                { id: "u1", name: "In already", orgUnitCategoryId: "cat-1" },
                { id: "u2", name: "From before", orgUnitCategoryId: null },
            ],
        });

        await expect(getOrgUnitsWithoutCategory(client, "t1")).resolves.toEqual([
            { id: "u2", name: "From before", orgUnitCategoryId: null },
        ]);
        expect(getAccessToken).toHaveBeenCalledWith("macaroon");
        expect(organization.getOrgUnits).toHaveBeenCalledWith(TOKEN, "t1");
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

        await expect(getOrgUnitsWithoutCategory(client, "t1")).rejects.toThrow("verjiOrganizationUrl");
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
        /** A space carrying the Verji state a guest org's personal space carries. */
        const makeSpace = (roomId: string, membership: Membership, tenantId = "t1", orgUnitId = "u1"): Room => {
            const state = [
                mkEvent({
                    event: true,
                    type: "app.verji.tenant_info",
                    skey: "app.verji.tenant_info",
                    room: roomId,
                    user: "@vsys:server",
                    content: { tenant_id: tenantId },
                }),
                mkEvent({
                    event: true,
                    type: "app.verji.org_unit_info",
                    skey: "app.verji.org_unit_info",
                    room: roomId,
                    user: "@vsys:server",
                    content: { org_unit_id: orgUnitId },
                }),
            ];
            return {
                roomId,
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
    });

    it("reads a conflict's reason, and nothing from any other failure", () => {
        expect(getConflictReason(new OrgUnitRoomConflictError("MemberOutsideOrgUnit"))).toBe("MemberOutsideOrgUnit");
        expect(getConflictReason(new OrgUnitRoomConflictError(undefined))).toBeUndefined();
        expect(getConflictReason(new Error("down"))).toBeNull();
        expect(getConflictReason("down")).toBeNull();
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
