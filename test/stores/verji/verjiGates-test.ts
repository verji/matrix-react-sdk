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
    spaceName: "Acme AS",
});

const TENANT_ROOT = ctxFor(VerjiSpaceKind.TenantRoot);
const CATEGORY = ctxFor(VerjiSpaceKind.OrgUnitCategory);
const ORG_UNIT = ctxFor(VerjiSpaceKind.OrgUnit, ORG_A);

/**
 * @param rolloutOn whether canonicalSpaceSyncEnabled is true for TENANT
 * @param grants role name -> instances the user holds it on, in TENANT only — so a read keyed by
 *     the wrong tenant gets a wrong answer rather than the same one
 */
const readerFor = (rolloutOn: boolean, grants: Record<string, string[]> = {}): VerjiGateReader => ({
    isCanonicalSpaceSyncEnabled: (tenantId) => rolloutOn && tenantId === TENANT,
    hasRole: (tenantId, roleName, instanceId) => tenantId === TENANT && (grants[roleName] ?? []).includes(instanceId),
});

const STANDARD_USER = { "Customer-User#": [TENANT] };
const GUEST = {};
const PRIMARY_CONTACT = { "Customer-User#": [TENANT], "Customer-Manager#": [TENANT] };

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

            it("renders today's behaviour when the tenant has no cached record at all", () => {
                // A cold cache reports the switch as false, which is exactly what must NOT gate.
                const coldCache: VerjiGateReader = {
                    isCanonicalSpaceSyncEnabled: () => false,
                    hasRole: () => false,
                };

                const decision = gate(TENANT_ROOT, coldCache);

                expect(decision.verdict).toBe(VerjiGateVerdict.NotGated);
                expect(isGateDisabled(decision)).toBe(false);
            });

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
            expect(decision.hint).toBe("Your account is a guest account in Acme AS, so you cannot invite new users.");
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
            expect(decision.hint).toBe("Your account is a guest account in Acme AS, so you cannot create rooms here.");
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
                // Rev 1 read the decided text as Member-only for room creation; confirmed on the
                // PR that the asymmetry was unintended.
                const reader = readerFor(true, { ...STANDARD_USER, Owner: [ORG_A] });

                expect(getCreateRoomGate(ORG_UNIT, reader).verdict).toBe(VerjiGateVerdict.Allowed);
            });

            it("denies a StandardUser who is neither, with the not-a-member hint", () => {
                const decision = getCreateRoomGate(ORG_UNIT, readerFor(true, STANDARD_USER));

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
                expect(decision.hint).toBe(
                    "Your account is a guest account in Acme AS, so you cannot create rooms here.",
                );
            });

            it("denies the edge case: holds the mirrored structure without membership", () => {
                // Member of a different org entirely. No special case is needed — the id simply is
                // not in any of their instance lists.
                const reader = readerFor(true, {
                    ...STANDARD_USER,
                    "ClientOrganization-User#": [ORG_B],
                    "Owner": [ORG_B],
                });

                expect(getCreateRoomGate(ORG_UNIT, reader).verdict).toBe(VerjiGateVerdict.Denied);
            });

            it("denies when the space claims to be an OrgUnit but carries no org unit id", () => {
                const reader = readerFor(true, { ...STANDARD_USER, "ClientOrganization-User#": [ORG_A] });
                const decision = getCreateRoomGate(ctxFor(VerjiSpaceKind.OrgUnit, undefined), reader);

                expect(decision.verdict).toBe(VerjiGateVerdict.Denied);
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
            const owner = readerFor(true, { ...STANDARD_USER, Owner: [ORG_A] });
            const member = readerFor(true, { ...STANDARD_USER, "ClientOrganization-User#": [ORG_A] });
            const neither = readerFor(true, STANDARD_USER);

            expect(getSpaceSettingsGate(ORG_UNIT, owner).verdict).toBe(VerjiGateVerdict.Allowed);
            expect(getSpaceSettingsGate(ORG_UNIT, member).verdict).toBe(VerjiGateVerdict.Allowed);
            expect(getSpaceSettingsGate(ORG_UNIT, neither).verdict).toBe(VerjiGateVerdict.Denied);
        });
    });

    describe("tenant isolation — the classic bug in this shape", () => {
        it("never answers with a decision belonging to a different tenant", () => {
            // The user has navigated to tenant B's space; only tenant A is cached and rolled out.
            const otherTenantCtx: VerjiSpaceContext = {
                tenantId: "tenant-2",
                kind: VerjiSpaceKind.TenantRoot,
                spaceName: "Other AS",
            };
            const readerKnowingOnlyTenant1: VerjiGateReader = {
                isCanonicalSpaceSyncEnabled: (tenantId) => tenantId === TENANT,
                hasRole: (tenantId, roleName, instanceId) =>
                    tenantId === TENANT && roleName === "Customer-User#" && instanceId === TENANT,
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
                };

                gate(ctx, reader);

                expect(tenantsAsked).not.toHaveLength(0);
                expect(tenantsAsked.filter((tenantId) => tenantId !== TENANT)).toEqual([]);
            });
        });
    });
});
