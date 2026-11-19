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
import { getVerjiApiSdk } from "@verji/verji-api-sdk/lib/asyncInit";

/**
 * VERJI: renaming a guest org (an OrgUnit) through the Organization API (verji/verji-src#2377).
 *
 * The name of a guest org's space is the guest org's name. Element renames the guest org, and the
 * backend copies the name to the guest org's space and every member's copy of it, written by `vsys`.
 * So a rename is accepted here long before the space shows it.
 */

/** The longest name, in UTF-16 code units, once trimmed; the Organization API refuses a longer one. */
export const MAX_ORG_UNIT_NAME_LENGTH = 255;

/** What came of asking the Organization API to rename a guest org. */
export enum OrgUnitRenameOutcome {
    /** Accepted (202): the space takes the new name in a few seconds. */
    Accepted = "accepted",
    /** Refused as blank or too long (400). */
    Invalid = "invalid",
    /** Refused because the user may no longer rename the guest org (403). */
    NoLongerAllowed = "no-longer-allowed",
    /** Refused for now: too many requests (429). */
    RateLimited = "rate-limited",
    /** Anything else: no Organization service, no token, the network, or another status. */
    Failed = "failed",
}

/** Is the name acceptable once trimmed: not blank, and at most {@link MAX_ORG_UNIT_NAME_LENGTH} long? */
export function isOrgUnitNameAcceptable(name: string): boolean {
    const trimmed = name.trim();
    return trimmed.length > 0 && trimmed.length <= MAX_ORG_UNIT_NAME_LENGTH;
}

/**
 * Rename the guest org `orgUnitId` of tenant `tenantId` to `name`, trimmed, as the signed-in user.
 * Never throws: every failure is an {@link OrgUnitRenameOutcome}, logged here.
 */
export async function setOrgUnitNameThroughVerji(
    client: MatrixClient,
    tenantId: string,
    orgUnitId: string,
    name: string,
): Promise<OrgUnitRenameOutcome> {
    try {
        const sdk = await getVerjiApiSdk();
        const organization = sdk.api.organizationService;
        const identity = sdk.api.identityService;
        if (!organization || !identity) {
            // eslint-disable-next-line no-console
            console.error("[Verji.OrgUnitName] The Organization or identity service is not configured.");
            return OrgUnitRenameOutcome.Failed;
        }
        const token = await identity.getAccessToken(client.getAccessToken() ?? "");
        await organization.setOrgUnitName(token, tenantId, orgUnitId, name.trim());
        return OrgUnitRenameOutcome.Accepted;
    } catch (error) {
        const status = (error as { response?: { status?: number } } | undefined)?.response?.status;
        // eslint-disable-next-line no-console
        console.error("[Verji.OrgUnitName] Renaming the guest org failed", status ?? "", error);
        switch (status) {
            case 400:
                return OrgUnitRenameOutcome.Invalid;
            case 403:
                return OrgUnitRenameOutcome.NoLongerAllowed;
            case 429:
                return OrgUnitRenameOutcome.RateLimited;
            default:
                return OrgUnitRenameOutcome.Failed;
        }
    }
}
