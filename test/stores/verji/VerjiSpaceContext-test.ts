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

import { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk/src/matrix";

import {
    deriveVerjiSpaceKind,
    resolveVerjiSpaceContext,
    VerjiSpaceKind,
} from "../../../src/stores/verji/VerjiSpaceContext";
import { getMockClientWithEventEmitter, mockClientMethodsUser } from "../../test-utils";

const USER = "@alice:domain.org";
const TENANT = "tenant-1";
const ORG_A = "org-a";

/**
 * Build a real Room and put real state events on it, rather than faking `currentState`. The point
 * of the exercise is that Verji custom events use the event type as their own state key, and only
 * the real state store proves the read matches the write.
 */
const makeSpace = (client: MatrixClient, events: Record<string, object>, roomId = "!space:domain.org"): Room => {
    const room = new Room(roomId, client, USER);
    jest.spyOn(room, "isSpaceRoom").mockReturnValue(true);
    room.currentState.setStateEvents(
        Object.entries(events).map(
            ([type, content]) =>
                new MatrixEvent({
                    type,
                    state_key: type, // Verji custom events key on their own type
                    room_id: room.roomId,
                    sender: USER,
                    content,
                }),
        ),
    );
    return room;
};

const TENANT_INFO = { "app.verji.tenant_info": { tenant_id: TENANT } };

describe("VerjiSpaceContext", () => {
    let client: MatrixClient;

    beforeEach(() => {
        client = getMockClientWithEventEmitter(mockClientMethodsUser(USER));
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe("resolveVerjiSpaceContext", () => {
        it("returns null for no space at all", () => {
            expect(resolveVerjiSpaceContext(null, [])).toBeNull();
            expect(resolveVerjiSpaceContext(undefined, [])).toBeNull();
        });

        it("returns null for a room that is not a space", () => {
            const room = makeSpace(client, TENANT_INFO);
            jest.spyOn(room, "isSpaceRoom").mockReturnValue(false);

            expect(resolveVerjiSpaceContext(room, [])).toBeNull();
        });

        it("returns null for a space with no tenant_info — not a surface this feature governs", () => {
            expect(resolveVerjiSpaceContext(makeSpace(client, {}), [])).toBeNull();
        });

        it("reads the tenant id and the org unit id", () => {
            const space = makeSpace(client, {
                ...TENANT_INFO,
                "app.verji.org_unit_info": { org_unit_id: ORG_A, org_unit_name: "Org A" },
            });

            const ctx = resolveVerjiSpaceContext(space, [])!;

            expect(ctx.tenantId).toBe(TENANT);
            expect(ctx.orgUnitId).toBe(ORG_A);
        });

        describe("the tenant name — what the hints must say", () => {
            // Standing is decided per tenant, so a hint rendered on an OrgUnit space must name the
            // tenant, not the OrgUnit.
            const orgUnitSpace = (): Room => {
                const space = makeSpace(client, {
                    ...TENANT_INFO,
                    "app.verji.org_unit_info": { org_unit_id: ORG_A },
                    "app.verji.canonical_parent_space": { canonical_parent_space_id: "!category:d.org" },
                });
                space.name = "Org A";
                return space;
            };
            const topLevel = (roomId: string, tenantId: string, name: string): Room => {
                const space = makeSpace(client, { "app.verji.tenant_info": { tenant_id: tenantId } }, roomId);
                space.name = name;
                return space;
            };

            it("names the tenant after its root space, not the space being rendered", () => {
                const roots = [
                    topLevel("!other-root:d.org", "tenant-2", "Other AS"),
                    topLevel("!root:d.org", TENANT, "Acme AS"),
                ];

                expect(resolveVerjiSpaceContext(orgUnitSpace(), roots)!.tenantName).toBe("Acme AS");
            });

            it("uses the space's own name when it is the tenant's root", () => {
                const root = topLevel("!root:d.org", TENANT, "Acme AS");

                expect(resolveVerjiSpaceContext(root, [root])!.tenantName).toBe("Acme AS");
            });

            it("falls back to the rendered space's name when the tenant's root is not in the space panel", () => {
                // Never another tenant's root, however close to hand.
                const roots = [topLevel("!other-root:d.org", "tenant-2", "Other AS")];

                expect(resolveVerjiSpaceContext(orgUnitSpace(), roots)!.tenantName).toBe("Org A");
            });
        });

        it("ignores an empty-string tenant id rather than treating it as a tenant", () => {
            const space = makeSpace(client, { "app.verji.tenant_info": { tenant_id: "" } });

            expect(resolveVerjiSpaceContext(space, [])).toBeNull();
        });

        it("ignores a non-string org unit id", () => {
            const space = makeSpace(client, {
                ...TENANT_INFO,
                "app.verji.org_unit_info": { org_unit_id: 42 },
            });

            const ctx = resolveVerjiSpaceContext(space, [])!;

            expect(ctx.orgUnitId).toBeUndefined();
            expect(ctx.kind).toBe(VerjiSpaceKind.TenantRoot);
        });

        describe("canonical space id — sibling coalesced with parent", () => {
            it("prefers the sibling pointer", () => {
                const space = makeSpace(client, {
                    ...TENANT_INFO,
                    "app.verji.canonical_sibling_space": { canonical_sibling_space_id: "!sib:d.org" },
                    "app.verji.canonical_parent_space": { canonical_parent_space_id: "!parent:d.org" },
                });

                expect(resolveVerjiSpaceContext(space, [])!.canonicalSpaceId).toBe("!sib:d.org");
            });

            it("falls back to the parent pointer for pre-split vintage spaces", () => {
                const space = makeSpace(client, {
                    ...TENANT_INFO,
                    "app.verji.canonical_parent_space": { canonical_parent_space_id: "!parent:d.org" },
                });

                expect(resolveVerjiSpaceContext(space, [])!.canonicalSpaceId).toBe("!parent:d.org");
            });
        });
    });

    describe("deriveVerjiSpaceKind", () => {
        it("is an OrgUnit when org_unit_info is present — checked before anything else", () => {
            // Even with a parent pointer and even at top level, org_unit_info wins.
            const space = makeSpace(client, {
                ...TENANT_INFO,
                "app.verji.org_unit_info": { org_unit_id: ORG_A },
                "app.verji.canonical_parent_space": { canonical_parent_space_id: "!parent:d.org" },
            });

            expect(deriveVerjiSpaceKind(space, true)).toBe(VerjiSpaceKind.OrgUnit);
            expect(deriveVerjiSpaceKind(space, false)).toBe(VerjiSpaceKind.OrgUnit);
        });

        it("is a TenantRoot when there is no parent pointer", () => {
            const space = makeSpace(client, TENANT_INFO);

            expect(deriveVerjiSpaceKind(space, false)).toBe(VerjiSpaceKind.TenantRoot);
        });

        it("is an OrgUnitCategory when it has a parent pointer and is not top level", () => {
            const space = makeSpace(client, {
                ...TENANT_INFO,
                "app.verji.canonical_parent_space": { canonical_parent_space_id: "!parent:d.org" },
            });

            expect(deriveVerjiSpaceKind(space, false)).toBe(VerjiSpaceKind.OrgUnitCategory);
        });

        it("applies the pre-split fallback: a top-level space with a parent pointer is a TenantRoot", () => {
            // A pre-split personal space carries the canonical it *mirrors* under
            // canonical_parent_space, so a tenant-root mirror of that vintage has one. Without this
            // branch it would read as an OrgUnitCategory and create-room would vanish for everyone
            // at the tenant root. Propagating the kind from the backend deletes this branch.
            const space = makeSpace(client, {
                ...TENANT_INFO,
                "app.verji.canonical_parent_space": { canonical_parent_space_id: "!canonical:d.org" },
            });

            expect(deriveVerjiSpaceKind(space, true)).toBe(VerjiSpaceKind.TenantRoot);
        });
    });
});
