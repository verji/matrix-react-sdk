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

import { KnownMembership } from "matrix-js-sdk/src/types";
import { MatrixClient, Room } from "matrix-js-sdk/src/matrix";
import { getVerjiApiSdk } from "@verji/verji-api-sdk/lib/asyncInit";
import { convertToVerjiSdkConfig, VerjiAppConfig } from "@verji/verji-api-sdk/lib/utils/convertConfig";
import { hasService } from "@verji/verji-api-sdk/lib/utils/isValidVerjiSdkConfig";

import type { OrgUnit, OrgUnitRoomCandidate, VerjiApiSdk } from "@verji/verji-api-sdk";
import SdkConfig from "../../SdkConfig";
import { resolveVerjiSpaceContext } from "./VerjiSpaceContext";

/**
 * VERJI: the Organization API calls that bring a tenant's guest orgs and rooms from before
 * Hierarchy V2 in (verji/verji-src#2117), for the tenant's PrimaryContact.
 *
 * Every write goes through the Organization API, which checks the caller and the room again and
 * starts the backend's own flows. The client never writes the space tree itself: no
 * `m.space.child` from here.
 *
 * The SDK is the one `VerjiPermissionsStore` initialises. The options that lead here are offered
 * only once that store has a tenant's access context, so the SDK is up by then.
 */

/**
 * Is the Organization API configured? Without `verjiOrganizationUrl` the SDK has no
 * `organizationService` and every call below fails, so the options that lead here are not
 * offered. Asked of the config the SDK is created from, the same way, so the menu can ask it
 * synchronously.
 */
export function isOrganizationApiConfigured(): boolean {
    // `IConfigOptions` does not declare the Verji URLs; `VerjiPermissionsStore` casts the same way.
    const appConfig = SdkConfig.get() as Partial<VerjiAppConfig>;
    return hasService(convertToVerjiSdkConfig(appConfig), "organization");
}

type OrganizationService = NonNullable<VerjiApiSdk["api"]["organizationService"]>;
type VerjiAccessToken = Parameters<OrganizationService["getOrgUnits"]>[0];

async function organizationApi(client: MatrixClient): Promise<[OrganizationService, VerjiAccessToken]> {
    const sdk = await getVerjiApiSdk();
    const organization = sdk.api.organizationService;
    if (!organization) throw new Error("[Verji.OrgUnitRooms] verjiOrganizationUrl is not configured");
    const identity = sdk.api.identityService;
    if (!identity) throw new Error("[Verji.OrgUnitRooms] verjiIdUrl is not configured");
    const token = await identity.getAccessToken(client.getAccessToken() ?? "");
    return [organization, token];
}

/** The tenant's org units that have no category yet: those that can be brought in. */
export async function getOrgUnitsWithoutCategory(client: MatrixClient, tenantId: string): Promise<OrgUnit[]> {
    const [organization, token] = await organizationApi(client);
    const page = await organization.getOrgUnits(token, tenantId);
    return (page.results ?? []).filter((orgUnit) => !orgUnit.orgUnitCategoryId);
}

/** Give the org unit the tenant's default category; its space follows asynchronously. */
export async function assignDefaultOrgUnitCategory(
    client: MatrixClient,
    tenantId: string,
    orgUnitId: string,
): Promise<void> {
    const [organization, token] = await organizationApi(client);
    await organization.assignDefaultOrgUnitCategory(token, tenantId, orgUnitId);
}

/** The rooms the caller is in that could be assigned to the org unit, each with how it fits. */
export async function getOrgUnitRoomCandidates(
    client: MatrixClient,
    tenantId: string,
    orgUnitId: string,
): Promise<OrgUnitRoomCandidate[]> {
    const [organization, token] = await organizationApi(client);
    const page = await organization.getOrgUnitRoomCandidates(token, tenantId, orgUnitId);
    return page.results ?? [];
}

/** Assign the room to the org unit's space. Throws `OrgUnitRoomConflictError` when it cannot be. */
export async function assignRoomToOrgUnit(
    client: MatrixClient,
    tenantId: string,
    orgUnitId: string,
    roomId: string,
): Promise<void> {
    const [organization, token] = await organizationApi(client);
    await organization.assignRoomToOrgUnit(token, tenantId, orgUnitId, roomId);
}

/**
 * A failure as one line of text, for the log. Never the error itself: an axios error carries the
 * request, and with it the caller's Verji access token, and the log goes into bug reports.
 */
export function describeError(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * The reason of an `OrgUnitRoomConflictError` (HTTP 409); `null` for any other failure. Read by
 * name rather than `instanceof`, so a second copy of the SDK in the bundle cannot hide a conflict.
 */
export function getConflictReason(error: unknown): string | undefined | null {
    if (error instanceof Error && error.name === "OrgUnitRoomConflictError") {
        const reason = (error as Error & { reason?: unknown }).reason;
        return typeof reason === "string" ? reason : undefined;
    }
    return null;
}

/**
 * The space the client has joined for the org unit: a space of the tenant whose `org_unit_info`
 * names it. For the tenant's PrimaryContact, their personal space of the guest org.
 */
export function findOrgUnitSpace(client: MatrixClient, tenantId: string, orgUnitId: string): Room | null {
    return (
        client.getRooms().find((room) => {
            if (room.getMyMembership() !== KnownMembership.Join) return false;
            const ctx = resolveVerjiSpaceContext(room, []);
            return ctx?.tenantId === tenantId && ctx.orgUnitId === orgUnitId;
        }) ?? null
    );
}
