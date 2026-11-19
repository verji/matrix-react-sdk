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
import { MatrixClient } from "matrix-js-sdk/src/matrix";
import { getVerjiApiSdk } from "@verji/verji-api-sdk/lib/asyncInit";

import {
    isOrgUnitNameAcceptable,
    MAX_ORG_UNIT_NAME_LENGTH,
    OrgUnitRenameOutcome,
    setOrgUnitNameThroughVerji,
} from "../../../src/stores/verji/verjiOrgUnitName";

jest.mock("@verji/verji-api-sdk/lib/asyncInit", () => ({
    getVerjiApiSdk: jest.fn(),
}));

const TENANT = "tenant-1";
const ORG_A = "org-a";

describe("verjiOrgUnitName", () => {
    let setOrgUnitName: jest.Mock;
    let getAccessToken: jest.Mock;
    const client = { getAccessToken: () => "macaroon" } as unknown as MatrixClient;

    const provideSdk = (api: Record<string, unknown>): void => {
        mocked(getVerjiApiSdk).mockResolvedValue({ api } as never);
    };

    beforeEach(() => {
        setOrgUnitName = jest.fn().mockResolvedValue(undefined);
        getAccessToken = jest.fn().mockResolvedValue({ access_token: "verji-token" });
        provideSdk({ organizationService: { setOrgUnitName }, identityService: { getAccessToken } });
        jest.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => jest.restoreAllMocks());

    describe("isOrgUnitNameAcceptable", () => {
        it.each([
            ["a name", "Fjordkraft Bygg AS", true],
            ["one character", "n", true],
            [`${MAX_ORG_UNIT_NAME_LENGTH} characters`, "n".repeat(MAX_ORG_UNIT_NAME_LENGTH), true],
            [`${MAX_ORG_UNIT_NAME_LENGTH} characters, padded`, `  ${"n".repeat(MAX_ORG_UNIT_NAME_LENGTH)}  `, true],
            [`${MAX_ORG_UNIT_NAME_LENGTH + 1} characters`, "n".repeat(MAX_ORG_UNIT_NAME_LENGTH + 1), false],
            ["nothing", "", false],
            ["whitespace only", " \t\n ", false],
        ])("%s: %s", (_what, name, acceptable) => {
            expect(isOrgUnitNameAcceptable(name)).toBe(acceptable);
        });
    });

    describe("setOrgUnitNameThroughVerji", () => {
        it("renames the guest org as the signed-in user, with the name trimmed", async () => {
            await expect(setOrgUnitNameThroughVerji(client, TENANT, ORG_A, "  New name \t")).resolves.toBe(
                OrgUnitRenameOutcome.Accepted,
            );

            expect(getAccessToken).toHaveBeenCalledWith("macaroon");
            expect(setOrgUnitName).toHaveBeenCalledWith({ access_token: "verji-token" }, TENANT, ORG_A, "New name");
        });

        it.each([
            [400, OrgUnitRenameOutcome.Invalid],
            [403, OrgUnitRenameOutcome.NoLongerAllowed],
            [429, OrgUnitRenameOutcome.RateLimited],
            [500, OrgUnitRenameOutcome.Failed],
            [404, OrgUnitRenameOutcome.Failed],
        ])("reads a %s from the Organization API as %s", async (status, outcome) => {
            setOrgUnitName.mockRejectedValue({ response: { status } });

            await expect(setOrgUnitNameThroughVerji(client, TENANT, ORG_A, "New name")).resolves.toBe(outcome);
            expect(console.error).toHaveBeenCalled();
        });

        it("reads a failure with no response, such as the network or a timeout, as Failed", async () => {
            setOrgUnitName.mockRejectedValue(new Error("timeout of 15000ms exceeded"));

            await expect(setOrgUnitNameThroughVerji(client, TENANT, ORG_A, "New name")).resolves.toBe(
                OrgUnitRenameOutcome.Failed,
            );
        });

        it("reads a failure to get a Verji token as Failed, and sends nothing", async () => {
            getAccessToken.mockRejectedValue(new Error("no token"));

            await expect(setOrgUnitNameThroughVerji(client, TENANT, ORG_A, "New name")).resolves.toBe(
                OrgUnitRenameOutcome.Failed,
            );
            expect(setOrgUnitName).not.toHaveBeenCalled();
        });

        it.each([
            ["the Organization service", { identityService: { getAccessToken: jest.fn() } }],
            ["the identity service", { organizationService: { setOrgUnitName: jest.fn() } }],
        ])("is Failed when %s is not configured", async (_what, api) => {
            provideSdk(api);

            await expect(setOrgUnitNameThroughVerji(client, TENANT, ORG_A, "New name")).resolves.toBe(
                OrgUnitRenameOutcome.Failed,
            );
        });
    });
});
