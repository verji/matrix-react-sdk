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

import { MatrixClient } from "matrix-js-sdk/src/matrix";
import { mocked } from "jest-mock";
import { getVerjiApiSdk } from "@verji/verji-api-sdk/lib/asyncInit";
import { OrgUnitRoomConflictError } from "@verji/verji-api-sdk";

import {
    assignDefaultOrgUnitCategory,
    assignRoomToOrgUnit,
    describeError,
    getConflictReason,
    getOrgUnitRoomCandidates,
    getOrgUnitsWithoutCategory,
} from "../../../src/stores/verji/verjiOrgUnitRooms";

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
