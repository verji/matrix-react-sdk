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

import {
    isOrgUnitMember,
    isOrgUnitOwner,
    isOrgUnitPrimaryContact,
    isStandardUser,
    isTenantPrimaryContact,
    VerjiRoleReader,
    VERJI_ROLE_NAMES_FOR_TEST,
} from "../../../src/stores/verji/verjiRoles";

const TENANT = "tenant-1";

/**
 * A reader backed by an explicit (role, instances) map for TENANT — the shape the ACL actually
 * returns. Any other tenant knows nothing, so a read keyed by the wrong tenant is denied.
 */
const readerFor = (grants: Record<string, string[]>): VerjiRoleReader => ({
    hasRole: (tenantId, roleName, instanceId) => tenantId === TENANT && (grants[roleName] ?? []).includes(instanceId),
});

/** A reader that records every (tenant, role, instance) it is asked about, and denies all. */
const recordingReader = (): { reader: VerjiRoleReader; asked: Array<[string, string, string]> } => {
    const asked: Array<[string, string, string]> = [];
    return {
        asked,
        reader: {
            hasRole: (tenantId, roleName, instanceId) => {
                asked.push([tenantId, roleName, instanceId]);
                return false;
            },
        },
    };
};

const ORG_A = "org-a";
const ORG_B = "org-b";

describe("verjiRoles — the client's role contract with itops", () => {
    // This is a contract test, not a tautology: the five strings are agreed with the backend
    // If one of them changes, this test is where it must be changed deliberately.
    it("names exactly the five agreed roles", () => {
        expect(VERJI_ROLE_NAMES_FOR_TEST).toEqual({
            tenantUserDirect: "Customer-User#",
            tenantManagerDirect: "Customer-Manager#",
            orgUnitUserDirect: "ClientOrganization-User#",
            orgUnitManagerDirect: "ClientOrganization-Manager#",
            orgUnitOwner: "Owner",
        });
    });

    describe("the trailing '#' — direct grants only", () => {
        // This is the single most dangerous detail in the whole feature. Without the '#', a tenant
        // admin's instance-hierarchy-expanded Customer-User covers every OrgUnit in the tenant, and
        // the OrgUnit gates would open for people who are not members of those OrgUnits.
        it("asks with the direct-grant twin, not the expanded role, in the tenant it was given", () => {
            const { reader, asked } = recordingReader();

            isStandardUser(reader, TENANT);
            isTenantPrimaryContact(reader, TENANT);
            isOrgUnitMember(reader, TENANT, ORG_A);
            isOrgUnitPrimaryContact(reader, TENANT, ORG_A);

            expect(asked).toEqual([
                [TENANT, "Customer-User#", TENANT],
                [TENANT, "Customer-Manager#", TENANT],
                [TENANT, "ClientOrganization-User#", ORG_A],
                [TENANT, "ClientOrganization-Manager#", ORG_A],
            ]);
            // Every one of them carries the suffix.
            expect(asked.every(([, role]) => role.endsWith("#"))).toBe(true);
        });

        it("denies an OrgUnit a tenant admin only reaches through expansion", () => {
            // The expanded role covers both orgs; the direct twin covers only the tenant. A gate
            // built on the expanded role would wrongly allow ORG_A here.
            const reader = readerFor({
                "Customer-User": [TENANT, ORG_A, ORG_B],
                "Customer-User#": [TENANT],
                "ClientOrganization-User#": [],
            });

            expect(isStandardUser(reader, TENANT)).toBe(true);
            expect(isOrgUnitMember(reader, TENANT, ORG_A)).toBe(false);
            expect(isOrgUnitMember(reader, TENANT, ORG_B)).toBe(false);
        });

        it("asks for Owner without a '#', because itops never expands it", () => {
            const { reader, asked } = recordingReader();

            isOrgUnitOwner(reader, TENANT, ORG_A);

            expect(asked).toEqual([[TENANT, "Owner", ORG_A]]);
        });
    });

    describe("instance scoping", () => {
        it("separates membership of one OrgUnit from another", () => {
            const reader = readerFor({ "ClientOrganization-User#": [ORG_A] });

            expect(isOrgUnitMember(reader, TENANT, ORG_A)).toBe(true);
            expect(isOrgUnitMember(reader, TENANT, ORG_B)).toBe(false);
        });

        it("reads the tenant predicates against the tenant id as the instance", () => {
            // A user granted Customer-User on some *org* instance rather than the tenant is not a
            // StandardUser of the tenant.
            const reader = readerFor({ "Customer-User#": [ORG_A] });

            expect(isStandardUser(reader, TENANT)).toBe(false);
        });
    });

    describe("default deny", () => {
        it("denies everything for a reader that knows nothing", () => {
            const reader = readerFor({});

            expect(isStandardUser(reader, TENANT)).toBe(false);
            expect(isTenantPrimaryContact(reader, TENANT)).toBe(false);
            expect(isOrgUnitMember(reader, TENANT, ORG_A)).toBe(false);
            expect(isOrgUnitPrimaryContact(reader, TENANT, ORG_A)).toBe(false);
            expect(isOrgUnitOwner(reader, TENANT, ORG_A)).toBe(false);
        });

        it("denies a superuser, who holds the wildcard instance 'X'", () => {
            // Deliberate: superusers get no client branch.
            const reader = readerFor({
                "Customer-User#": ["X"],
                "Customer-Manager#": ["X"],
                "ClientOrganization-User#": ["X"],
                "Owner": ["X"],
            });

            expect(isStandardUser(reader, TENANT)).toBe(false);
            expect(isTenantPrimaryContact(reader, TENANT)).toBe(false);
            expect(isOrgUnitMember(reader, TENANT, ORG_A)).toBe(false);
            expect(isOrgUnitOwner(reader, TENANT, ORG_A)).toBe(false);
        });
    });
});
