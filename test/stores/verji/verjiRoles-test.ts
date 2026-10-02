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
    isOrgUnitInContext,
    isOrgUnitMember,
    isOrgUnitMemberOrOwner,
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
    isInstanceReferenced: (tenantId, instanceId) =>
        tenantId === TENANT && Object.values(grants).some((instances) => instances.includes(instanceId)),
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
            isInstanceReferenced: (tenantId, instanceId) => {
                asked.push([tenantId, "<any role>", instanceId]);
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
            orgUnitOwner: "ClientOrganization-Owner",
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

        it("asks for ClientOrganization-Owner without a '#', because itops never expands it", () => {
            const { reader, asked } = recordingReader();

            isOrgUnitOwner(reader, TENANT, ORG_A);

            expect(asked).toEqual([[TENANT, "ClientOrganization-Owner", ORG_A]]);
        });

        it("does not read the bare Owner role as OrgUnit ownership", () => {
            // A bare `Owner` row can sit on the guest org itself — the group policy writes one for
            // the person its groups were synced from, who need not be its owner. Only the row the
            // owner sync writes, `ClientOrganization-Owner`, is the owner signal.
            expect(isOrgUnitOwner(readerFor({ Owner: [ORG_A] }), TENANT, ORG_A)).toBe(false);
            expect(isOrgUnitOwner(readerFor({ "ClientOrganization-Owner": [ORG_A] }), TENANT, ORG_A)).toBe(true);
        });
    });

    describe("isOrgUnitMemberOrOwner — the standing to act in an OrgUnit", () => {
        it.each([
            ["a Member", { "ClientOrganization-User#": [ORG_A] }, true],
            ["the Owner", { "ClientOrganization-Owner": [ORG_A] }, true],
            ["a bare Owner row, which is not the owner signal", { Owner: [ORG_A] }, false],
            ["a non-member who joined one of its rooms", { "ClientOrganization-SmsRoomMember": [ORG_A] }, false],
            ["a Member of another OrgUnit", { "ClientOrganization-User#": [ORG_B] }, false],
        ])("reads %s as %s", (_who, grants, expected) => {
            expect(isOrgUnitMemberOrOwner(readerFor(grants), TENANT, ORG_A)).toBe(expected);
        });

        it("asks exactly the Member and Owner predicates, in the tenant it was given", () => {
            const { reader, asked } = recordingReader();

            isOrgUnitMemberOrOwner(reader, TENANT, ORG_A);

            expect(asked).toEqual([
                [TENANT, "ClientOrganization-User#", ORG_A],
                [TENANT, "ClientOrganization-Owner", ORG_A],
            ]);
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
            expect(isOrgUnitInContext(reader, TENANT, ORG_A)).toBe(false);
        });
    });

    /**
     * The staleness signal behind the create-room gate's "checking" verdict (verji/verji-src#1507).
     * It must be role-agnostic: the roles that put an OrgUnit into someone's context include ones
     * the contract above never names, and a scan limited to the five would read a non-member who
     * joined one of its rooms as "stale" for good.
     */
    describe("isOrgUnitInContext — has the context heard of the OrgUnit at all", () => {
        it.each([
            ["a Member", "ClientOrganization-User#"],
            ["the Owner", "ClientOrganization-Owner"],
            ["the tenant PrimaryContact, through an expanded manager role", "ClientOrganization-Manager"],
            ["a non-member who joined one of its rooms", "ClientOrganization-SmsRoomMember"],
        ])("finds it for %s", (_who, roleName) => {
            expect(
                isOrgUnitInContext(readerFor({ "Customer-User#": [TENANT], [roleName]: [ORG_A] }), TENANT, ORG_A),
            ).toBe(true);
        });

        it("does not find an OrgUnit no role lists", () => {
            const reader = readerFor({ "Customer-User#": [TENANT], "ClientOrganization-User#": [ORG_B] });

            expect(isOrgUnitInContext(reader, TENANT, ORG_A)).toBe(false);
        });

        it("asks about the tenant it was given and nothing else", () => {
            const { reader, asked } = recordingReader();

            isOrgUnitInContext(reader, TENANT, ORG_A);

            expect(asked).toEqual([[TENANT, "<any role>", ORG_A]]);
        });

        it("is never a grant: an OrgUnit the context mentions is not membership", () => {
            const reader = readerFor({ "ClientOrganization-SmsRoomMember": [ORG_A] });

            expect(isOrgUnitInContext(reader, TENANT, ORG_A)).toBe(true);
            expect(isOrgUnitMember(reader, TENANT, ORG_A)).toBe(false);
            expect(isOrgUnitOwner(reader, TENANT, ORG_A)).toBe(false);
        });
    });

    describe("superusers — no client branch", () => {
        // A superuser's own grants live in a separate `superuser` domain and never reach a tenant's
        // access context; `isSuperuser` is the only trace. The predicates read roles alone, so a
        // superuser reads as their standing in the tenant — nothing more, nothing less. The reader
        // below carries that trace, so a superuser branch added to any predicate shows up here.
        const asSuperuser = (reader: VerjiRoleReader): VerjiRoleReader =>
            ({ ...reader, isSuperuser: () => true }) as VerjiRoleReader;

        /** Every predicate's answer, in contract order. */
        const standingOf = (reader: VerjiRoleReader): boolean[] => [
            isStandardUser(reader, TENANT),
            isTenantPrimaryContact(reader, TENANT),
            isOrgUnitMember(reader, TENANT, ORG_A),
            isOrgUnitPrimaryContact(reader, TENANT, ORG_A),
            isOrgUnitOwner(reader, TENANT, ORG_A),
        ];

        it("reads a superuser with no standing in the tenant as denied at every predicate", () => {
            // What production serves: an empty roles list for the tenant.
            expect(standingOf(asSuperuser(readerFor({})))).toEqual([false, false, false, false, false]);
        });

        it("reads a superuser who is also a StandardUser exactly as that StandardUser", () => {
            const rows = { "Customer-User#": [TENANT], "ClientOrganization-User#": [ORG_A] };

            expect(standingOf(asSuperuser(readerFor(rows)))).toEqual(standingOf(readerFor(rows)));
            expect(standingOf(asSuperuser(readerFor(rows)))).toEqual([true, false, true, false, false]);
        });
    });
});
