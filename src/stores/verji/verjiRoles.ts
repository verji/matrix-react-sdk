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

/**
 * VERJI: the role contract.
 *
 * This is the ONLY file in the client that may name an itops Casbin role. Every gate asks its
 * question through the predicates below, so a backend rename is a one-file change here rather than
 * a hunt across components, which is the whole defence against role-name drift.
 *
 * ## The trailing `#` is load-bearing
 *
 * itops emits, for every role, both the instance-hierarchy-expanded instance list and a `{role}#`
 * twin holding only the instances the user was **directly** granted. A plain role mixes the two: a
 * tenant user's plain `Customer-User` also lists the OrgUnits it reaches by inheritance, so asking
 * with it would open the OrgUnit gates for people who are not members of those OrgUnits. Always ask
 * with the `#` twin — never gate on a plain role, nor read one's instances.
 *
 * `ClientOrganization-Owner` is the exception: itops never recurses an `…Owner` role, so it is
 * inherently direct and correctly has no `#` twin. It is the row the owner sync writes for the
 * owner recorded on the guest org. A bare `Owner` row can also sit on a guest org (the group
 * policy writes one for the person the org's groups were synced from, who need not be its
 * owner), so the bare role is not the owner signal.
 *
 * ## Superusers read as their tenant standing
 *
 * A superuser's own grants live in a separate `superuser` domain and never appear in a tenant's
 * access context: it lists only what they hold in that tenant, like anyone else's, and
 * `isSuperuser` is the only trace. A superuser with no standing in the tenant therefore reads
 * denied at every predicate below; one who is also, say, a StandardUser reads exactly as that.
 * Deliberately not special-cased: superuser access is internal and limited, and the concept is
 * being phased out.
 */

/** Directly granted `Customer-User` — the StandardUser signal. Instance is the tenant id. */
const ROLE_TENANT_USER_DIRECT = "Customer-User#";
/** Directly granted `Customer-Manager` — the tenant's PrimaryContact. Instance is the tenant id. */
const ROLE_TENANT_MANAGER_DIRECT = "Customer-Manager#";
/** Directly granted `ClientOrganization-User` — OrgUnit membership. Instance is the OrgUnit id. */
const ROLE_ORG_UNIT_USER_DIRECT = "ClientOrganization-User#";
/** Directly granted `ClientOrganization-Manager` — the OrgUnit's PrimaryContact. */
const ROLE_ORG_UNIT_MANAGER_DIRECT = "ClientOrganization-Manager#";
/**
 * The OrgUnit's Owner — the owner recorded on the guest org, written by the owner sync. Never
 * recursed, so no `#` twin.
 */
const ROLE_ORG_UNIT_OWNER = "ClientOrganization-Owner";

/**
 * The slice of `sdk.permissions` these predicates need.
 *
 * Narrowed to the two role-map reads on purpose: it keeps this module free of any dependency on
 * the bridge store or the SDK, so the contract can be unit-tested against a few-line stub.
 */
export interface VerjiRoleReader {
    /**
     * Mirrors the backend's `AcContext.HasRole`. Default-deny: false for an unknown tenant, an
     * unknown role, or a context that has not loaded.
     */
    hasRole(tenantId: string, roleName: string, instanceId: string): boolean;
    /**
     * Is `instanceId` in the instance list of **any** role in the tenant's cached context, whatever
     * the role? False for an unknown tenant or a context that has not loaded.
     *
     * Never a grant. It answers "has this context heard of the instance at all" — see
     * {@link isOrgUnitInContext} for why that is worth asking.
     */
    isInstanceReferenced(tenantId: string, instanceId: string): boolean;
}

/**
 * Is the user a StandardUser of this tenant — a Person associated directly with the Tenant, as
 * opposed to a Guest who reaches it only through a GuestOrg?
 *
 * A Guest holds no `Customer-*` row at all (itops inheritance runs tenant → org, never upward), so
 * this is exact, and a person associated at both levels correctly reads as a StandardUser.
 */
export function isStandardUser(roles: VerjiRoleReader, tenantId: string): boolean {
    return roles.hasRole(tenantId, ROLE_TENANT_USER_DIRECT, tenantId);
}

/** Is the user the PrimaryContact of this tenant? */
export function isTenantPrimaryContact(roles: VerjiRoleReader, tenantId: string): boolean {
    return roles.hasRole(tenantId, ROLE_TENANT_MANAGER_DIRECT, tenantId);
}

/** Is the user a Member of this OrgUnit? */
export function isOrgUnitMember(roles: VerjiRoleReader, tenantId: string, orgUnitId: string): boolean {
    return roles.hasRole(tenantId, ROLE_ORG_UNIT_USER_DIRECT, orgUnitId);
}

/** Is the user the PrimaryContact of this OrgUnit? */
export function isOrgUnitPrimaryContact(roles: VerjiRoleReader, tenantId: string, orgUnitId: string): boolean {
    return roles.hasRole(tenantId, ROLE_ORG_UNIT_MANAGER_DIRECT, orgUnitId);
}

/** Is the user the Owner of this OrgUnit — the tenant user who created it? */
export function isOrgUnitOwner(roles: VerjiRoleReader, tenantId: string, orgUnitId: string): boolean {
    return roles.hasRole(tenantId, ROLE_ORG_UNIT_OWNER, orgUnitId);
}

/**
 * Has the tenant's cached access context heard of this OrgUnit at all, under any role?
 *
 * Not a permission, and never a reason to allow: it is how a gate tells a genuine "no" from a copy
 * of the context that predates the OrgUnit (verji/verji-src#1507). Anyone who can see an OrgUnit's
 * space has its id somewhere in a current context — as a Member, as the Owner, as the tenant
 * PrimaryContact through the expanded manager roles, or as a non-member who joined one of its rooms
 * (`ClientOrganization-SmsRoomMember`). So a context that mentions it nowhere most likely predates
 * it, as when a guest org is created after page load.
 *
 * Most likely, not certainly: a user who just left their last room in it keeps the space for a
 * moment after their grant is gone. Hence the re-fetch this triggers is bounded, and a gate falls
 * back to denial once it is used up.
 *
 * Deliberately role-agnostic, so the roles that put an OrgUnit into a context can change on the
 * backend without a change here.
 */
export function isOrgUnitInContext(roles: VerjiRoleReader, tenantId: string, orgUnitId: string): boolean {
    return roles.isInstanceReferenced(tenantId, orgUnitId);
}

/**
 * Exported for the contract test only, so a rename of any of the five shows up as a deliberate
 * test change rather than a silent behaviour change. Not for use by gates — call the predicates.
 */
export const VERJI_ROLE_NAMES_FOR_TEST = {
    tenantUserDirect: ROLE_TENANT_USER_DIRECT,
    tenantManagerDirect: ROLE_TENANT_MANAGER_DIRECT,
    orgUnitUserDirect: ROLE_ORG_UNIT_USER_DIRECT,
    orgUnitManagerDirect: ROLE_ORG_UNIT_MANAGER_DIRECT,
    orgUnitOwner: ROLE_ORG_UNIT_OWNER,
} as const;
