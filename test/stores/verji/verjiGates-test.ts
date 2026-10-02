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
    getCreateRoomGate,
    getOnboardToTenantGate,
    getSpaceSettingsGate,
    isGateDisabled,
    isGateVisible,
    VerjiGateReader,
    VerjiGateVerdict,
} from "../../../src/stores/verji/verjiGates";
import { VerjiSpaceContext, VerjiSpaceKind } from "../../../src/stores/verji/VerjiSpaceContext";

const TENANT = "tenant-1";
const ORG_A = "org-a";
const ORG_B = "org-b";

const ctxFor = (kind: VerjiSpaceKind, orgUnitId?: string): VerjiSpaceContext => ({
    tenantId: TENANT,
    orgUnitId,
    kind,
    tenantName: "Acme AS",
});

const TENANT_ROOT = ctxFor(VerjiSpaceKind.TenantRoot);
const CATEGORY = ctxFor(VerjiSpaceKind.OrgUnitCategory);
const ORG_UNIT = ctxFor(VerjiSpaceKind.OrgUnit, ORG_A);

/**
 * @param rolloutOn whether canonicalSpaceSyncEnabled is true for TENANT
 * @param grants role name -> instances the user holds it on, in TENANT only — so a read keyed by
 *     the wrong tenant gets a wrong answer rather than the same one
 * @param exhausted OrgUnits of TENANT whose re-fetch the store has used up
 */
const readerFor = (
    rolloutOn: boolean,
    grants: Record<string, string[]> = {},
    exhausted: string[] = [],
): VerjiGateReader => ({
    isCanonicalSpaceSyncEnabled: (tenantId) => rolloutOn && tenantId === TENANT,
    hasRole: (tenantId, roleName, instanceId) => tenantId === TENANT && (grants[roleName] ?? []).includes(instanceId),
    isInstanceReferenced: (tenantId, instanceId) =>
        tenantId === TENANT && Object.values(grants).some((instances) => instances.includes(instanceId)),
    isOrgUnitRefreshExhausted: (tenantId, orgUnitId) => tenantId === TENANT && exhausted.includes(orgUnitId),
});

const STANDARD_USER = { "Customer-User#": [TENANT] };
const GUEST = {};
const PRIMARY_CONTACT = { "Customer-User#": [TENANT], "Customer-Manager#": [TENANT] };
/**
 * Puts ORG_A in the context without making the user a Member or the Owner — what the backend
 * writes for a non-member who joined one of the org's rooms. A context carrying it is current
 * about ORG_A, so a "no" is a genuine no.
 */
const JOINED_A_ROOM_IN_ORG_A = { "ClientOrganization-SmsRoomMember": [ORG_A] };

const ALL_GATES = [
    ["onboard to tenant", getOnboardToTenantGate],
    ["create room", getCreateRoomGate],
    ["space settings", getSpaceSettingsGate],
] as const;

const ALL_CONTEXTS = [
    ["TenantRoot", TENANT_ROOT],
    ["OrgUnitCategory", CATEGORY],
    ["OrgUnit", ORG_UNIT],
] as const;

describe("verjiGates", () => {
    /**
     * The hard product requirement, and the single worst defect available in this work: a gate
     * that ignores the rollout switch silently restricts production users who were never meant to
     * be in the beta. Asserted for every gate against every space kind and every role shape, so a
     * new gate that forgets the short-circuit is caught here rather than in production.
     */
    describe("the rollout switch — gating must be invisible outside the beta", () => {
        describe.each(ALL_GATES)("%s", (_name, gate) => {
            describe.each(ALL_CONTEXTS)("at a %s space", (_kindName, ctx) => {
                it.each([
                    ["a Guest", GUEST],
                    ["a StandardUser", STANDARD_USER],
                    ["the tenant PrimaryContact", PRIMARY_CONTACT],
                ])("renders today's behaviour for %s when the switch is off", (_who, grants) => {
                    const decision = gate(ctx, readerFor(false, grants));

                    expect(decision.verdict).toBe(VerjiGateVerdict.NotGated);
                    expect(decision.hint).toBeUndefined();
                    // Today's behaviour is: visible and not disabled. Neither "deny" nor "checking".
                    expect(isGateVisible(decision)).toBe(true);
                    expect(isGateDisabled(decision)).toBe(false);
                });
            });

            it.each(ALL_CONTEXTS)(
                "renders today's behaviour at a %s space when the tenant has no cached record at all",
                (_kindName, ctx) => {
                    // A cold cache reports the switch as false, which is exactly what must NOT gate.
                    // At an OrgUnit it also has not heard of the OrgUnit, which must not read as
                    // "checking" either: the cold-cache "checking…" state is deliberately not built.
                    const coldCache: VerjiGateReader = {
                        isCanonicalSpaceSyncEnabled: () => false,
                        hasRole: () => false,
                        isInstanceReferenced: () => false,
                        isOrgUnitRefreshExhausted: () => false,
                    };

                    const decision = gate(ctx, coldCache);

                    expect(decision.verdict).toBe(VerjiGateVerdict.NotGated);
                    expect(decision.hint).toBeUndefined();
                    expect(isGateDisabled(decision)).toBe(false);
                },
            );

            it("renders today's behaviour when the room is not a Verji space", () => {
                // Switch reported on, but there is no context — must still not gate.
                const decision = gate(null, readerFor(true, STANDARD_USER));

                expect(decision.verdict).toBe(VerjiGateVerdict.NotGated);
                expect(isGateDisabled(decision)).toBe(false);
            });
        });
    });

    describe("onboard user to tenant", () => {
        it("allows a StandardUser", () => {
            const decision = getOnboardToTenantGate(TENANT_ROOT, readerFor(true, STANDARD_USER));

            expect(decision.verdict).toBe(VerjiGateVerdict.Allowed);
            expect(isGateDisabled(decision)).toBe(false);
        });

        it("denies a Guest, with a hint naming their own standing and no one else", () => {
            // The exact text is the assertion: telling a Guest who the tenant's primary contact is
            // would disclose something no other surface does, so the hint names only their own
            // standing and the tenant.
            const decision = getOnboardToTenantGate(TENANT_ROOT, readerFor(true, GUEST));

            expect(decision.verdict).toBe(VerjiGateVerdict.Denied);
            expect(isGateDisabled(decision)).toBe(true);
            expect(decision.hint).toBe("You are a guest in Acme AS, so you cannot invite new users to this space.");
        });
    });

    describe("create room", () => {
        it("allows a StandardUser at a TenantRoot", () => {
            expect(getCreateRoomGate(TENANT_ROOT, readerFor(true, STANDARD_USER)).verdict).toBe(
                VerjiGateVerdict.Allowed,
            );
        });

        it("denies a Guest at a TenantRoot with the guest hint", () => {
            const decision = getCreateRoomGate(TENANT_ROOT, readerFor(true, GUEST));

            expect(decision.verdict).toBe(VerjiGateVerdict.Denied);
            expect(decision.hint).toBe("You are a guest in Acme AS, so you cannot create rooms in this space.");
        });

        it("hides the affordance at an OrgUnitCategory for everyone", () => {
            for (const grants of [GUEST, STANDARD_USER, PRIMARY_CONTACT]) {
                const decision = getCreateRoomGate(CATEGORY, readerFor(true, grants));

                expect(decision.verdict).toBe(VerjiGateVerdict.Hidden);
                expect(isGateVisible(decision)).toBe(false);
            }
        });

        describe("at an OrgUnit space", () => {
            it("allows a StandardUser who is a Member", () => {
                const reader = readerFor(true, {
                    ...STANDARD_USER,
                    "ClientOrganization-User#": [ORG_A],
                });

                expect(getCreateRoomGate(ORG_UNIT, reader).verdict).toBe(VerjiGateVerdict.Allowed);
            });

            it("allows a StandardUser who is the Owner", () => {
                // Room creation and space settings deliberately share the Member-or-Owner rule; a
                // Member-only reading for room creation would be the asymmetric one.
                const reader = readerFor(true, { ...STANDARD_USER, "ClientOrganization-Owner": [ORG_A] });

                expect(getCreateRoomGate(ORG_UNIT, reader).verdict).toBe(VerjiGateVerdict.Allowed);
            });

            it("denies a StandardUser who is neither, with the not-a-member hint", () => {
                const decision = getCreateRoomGate(
                    ORG_UNIT,
                    readerFor(true, { ...STANDARD_USER, ...JOINED_A_ROOM_IN_ORG_A }),
                );

                expect(decision.verdict).toBe(VerjiGateVerdict.Denied);
                expect(decision.hint).toBe(
                    "You are not a member of this organisation, so you cannot create rooms here.",
                );
            });

            it("denies a Guest with the guest hint, not the not-a-member hint", () => {
                // Two distinct denial reasons; the hint must name the one that actually applies.
                const reader = readerFor(true, { "ClientOrganization-User#": [ORG_A] });
                const decision = getCreateRoomGate(ORG_UNIT, reader);

                expect(decision.verdict).toBe(VerjiGateVerdict.Denied);
                expect(decision.hint).toBe("You are a guest in Acme AS, so you cannot create rooms in this space.");
            });

            it("denies the edge case: holds the mirrored structure without membership", () => {
                // Member and Owner of a different org; in ORG_A only through a room they joined.
                // No special case is needed — ORG_A is in their context, just not as membership.
                const reader = readerFor(true, {
                    ...STANDARD_USER,
                    ...JOINED_A_ROOM_IN_ORG_A,
                    "ClientOrganization-User#": [ORG_B],
                    "ClientOrganization-Owner": [ORG_B],
                });

                expect(getCreateRoomGate(ORG_UNIT, reader).verdict).toBe(VerjiGateVerdict.Denied);
            });

            it("denies when the space claims to be an OrgUnit but carries no org unit id", () => {
                const reader = readerFor(true, { ...STANDARD_USER, "ClientOrganization-User#": [ORG_A] });
                const decision = getCreateRoomGate(ctxFor(VerjiSpaceKind.OrgUnit, undefined), reader);

                expect(decision.verdict).toBe(VerjiGateVerdict.Denied);
            });

            /**
             * verji/verji-src#1507. "Not a Member or Owner" covers two situations, and only one is a
             * genuine no: a cached context that has never heard of the OrgUnit most likely predates
             * it, as when a guest org is created after page load.
             */
            describe("when the cached context has never heard of the OrgUnit", () => {
                it("reads Checking for a StandardUser: still disabled, with the checking hint", () => {
                    const decision = getCreateRoomGate(ORG_UNIT, readerFor(true, STANDARD_USER));

                    expect(decision.verdict).toBe(VerjiGateVerdict.Checking);
                    expect(decision.hint).toBe("Checking your access…");
                    expect(isGateVisible(decision)).toBe(true);
                    expect(isGateDisabled(decision)).toBe(true);
                });

                it("settles on the not-a-member denial once the store's re-fetch is used up", () => {
                    const decision = getCreateRoomGate(ORG_UNIT, readerFor(true, STANDARD_USER, [ORG_A]));

                    expect(decision.verdict).toBe(VerjiGateVerdict.Denied);
                    expect(decision.hint).toBe(
                        "You are not a member of this organisation, so you cannot create rooms here.",
                    );
                });

                it("keeps checking when only another OrgUnit's re-fetch is used up", () => {
                    const decision = getCreateRoomGate(ORG_UNIT, readerFor(true, STANDARD_USER, [ORG_B]));

                    expect(decision.verdict).toBe(VerjiGateVerdict.Checking);
                });

                it.each([
                    ["while the re-fetch runs", []],
                    ["after it is used up", [ORG_A]],
                ])("allows once a fetch brings the Owner row, %s", (_when, exhausted) => {
                    const reader = readerFor(
                        true,
                        { ...STANDARD_USER, "ClientOrganization-Owner": [ORG_A] },
                        exhausted,
                    );

                    expect(getCreateRoomGate(ORG_UNIT, reader).verdict).toBe(VerjiGateVerdict.Allowed);
                });

                it("denies a Guest with the guest hint rather than checking", () => {
                    // A Guest may not create rooms anywhere in the tenant, whatever the OrgUnit.
                    const decision = getCreateRoomGate(ORG_UNIT, readerFor(true, GUEST));

                    expect(decision.verdict).toBe(VerjiGateVerdict.Denied);
                    expect(decision.hint).toBe("You are a guest in Acme AS, so you cannot create rooms in this space.");
                });

                it("never reads Checking outside the beta", () => {
                    const decision = getCreateRoomGate(ORG_UNIT, readerFor(false, STANDARD_USER));

                    expect(decision.verdict).toBe(VerjiGateVerdict.NotGated);
                    expect(isGateDisabled(decision)).toBe(false);
                });
            });
        });
    });

    describe("space settings (specified; the surface lands with avatar propagation)", () => {
        it("allows the tenant PrimaryContact at a TenantRoot and at a category", () => {
            const reader = readerFor(true, PRIMARY_CONTACT);

            expect(getSpaceSettingsGate(TENANT_ROOT, reader).verdict).toBe(VerjiGateVerdict.Allowed);
            expect(getSpaceSettingsGate(CATEGORY, reader).verdict).toBe(VerjiGateVerdict.Allowed);
        });

        it("denies a StandardUser who is not the PrimaryContact", () => {
            const decision = getSpaceSettingsGate(TENANT_ROOT, readerFor(true, STANDARD_USER));

            expect(decision.verdict).toBe(VerjiGateVerdict.Denied);
            expect(decision.hint).toBe(
                "You are not the primary contact for Acme AS, so you cannot change these settings.",
            );
        });

        it("uses Member-or-Owner, not PrimaryContact, at an OrgUnit", () => {
            const owner = readerFor(true, { ...STANDARD_USER, "ClientOrganization-Owner": [ORG_A] });
            const member = readerFor(true, { ...STANDARD_USER, "ClientOrganization-User#": [ORG_A] });
            const neither = readerFor(true, STANDARD_USER);

            expect(getSpaceSettingsGate(ORG_UNIT, owner).verdict).toBe(VerjiGateVerdict.Allowed);
            expect(getSpaceSettingsGate(ORG_UNIT, member).verdict).toBe(VerjiGateVerdict.Allowed);
            expect(getSpaceSettingsGate(ORG_UNIT, neither).verdict).toBe(VerjiGateVerdict.Denied);
        });

        it("denies, rather than checks, at an OrgUnit the context has never heard of", () => {
            // Pinned on purpose: with no surface there is no hook to drive a re-fetch, so a Checking
            // verdict here could never settle. Revisit when the surface lands.
            const decision = getSpaceSettingsGate(ORG_UNIT, readerFor(true, STANDARD_USER));

            expect(decision.verdict).toBe(VerjiGateVerdict.Denied);
        });
    });

    describe("tenant isolation — the classic bug in this shape", () => {
        it("never answers with a decision belonging to a different tenant", () => {
            // The user has navigated to tenant B's space; only tenant A is cached and rolled out.
            const otherTenantCtx: VerjiSpaceContext = {
                tenantId: "tenant-2",
                kind: VerjiSpaceKind.TenantRoot,
                tenantName: "Other AS",
            };
            const readerKnowingOnlyTenant1: VerjiGateReader = {
                isCanonicalSpaceSyncEnabled: (tenantId) => tenantId === TENANT,
                hasRole: (tenantId, roleName, instanceId) =>
                    tenantId === TENANT && roleName === "Customer-User#" && instanceId === TENANT,
                isInstanceReferenced: (tenantId, instanceId) => tenantId === TENANT && instanceId === TENANT,
                isOrgUnitRefreshExhausted: () => false,
            };

            // Tenant 2 is simply not gated — it must not inherit tenant 1's rollout or roles.
            expect(getCreateRoomGate(otherTenantCtx, readerKnowingOnlyTenant1).verdict).toBe(VerjiGateVerdict.NotGated);
        });

        describe.each(ALL_GATES)("%s", (_name, gate) => {
            it.each(ALL_CONTEXTS)("at a %s space, asks about the rendered space's tenant only", (_kindName, ctx) => {
                const tenantsAsked: string[] = [];
                const reader: VerjiGateReader = {
                    // Switch on, so the gate goes past the short-circuit into its role reads.
                    isCanonicalSpaceSyncEnabled: (tenantId) => {
                        tenantsAsked.push(tenantId);
                        return true;
                    },
                    // A StandardUser and nothing else, so the OrgUnit gates run through every
                    // predicate they use rather than stopping at the first.
                    hasRole: (tenantId, roleName) => {
                        tenantsAsked.push(tenantId);
                        return roleName === "Customer-User#";
                    },
                    isInstanceReferenced: (tenantId) => {
                        tenantsAsked.push(tenantId);
                        return false;
                    },
                    isOrgUnitRefreshExhausted: (tenantId) => {
                        tenantsAsked.push(tenantId);
                        return false;
                    },
                };

                gate(ctx, reader);

                expect(tenantsAsked).not.toHaveLength(0);
                expect(tenantsAsked.filter((tenantId) => tenantId !== TENANT)).toEqual([]);
            });
        });
    });
});
