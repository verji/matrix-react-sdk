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

import React from "react";
import { renderToString } from "react-dom/server";
import { act, renderHook } from "@testing-library/react-hooks/dom";
import { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk/src/matrix";

import { useVerjiGate } from "../../src/hooks/useVerjiPermissions";
import SpaceStore from "../../src/stores/spaces/SpaceStore";
import { VerjiPermissionsStore } from "../../src/stores/verji/VerjiPermissionsStore";
import { VerjiGateDecision, VerjiGateVerdict } from "../../src/stores/verji/verjiGates";
import { VerjiSpaceContext, VerjiSpaceKind } from "../../src/stores/verji/VerjiSpaceContext";
import { getMockClientWithEventEmitter, mockClientMethodsUser } from "../test-utils";

const USER = "@alice:domain.org";

/** A real Room carrying real Verji state events, keyed on their own type as itops-matrix writes them. */
const makeSpace = (client: MatrixClient, roomId: string, events: Record<string, object>): Room => {
    const room = new Room(roomId, client, USER);
    jest.spyOn(room, "isSpaceRoom").mockReturnValue(true);
    room.currentState.setStateEvents(
        Object.entries(events).map(
            ([type, content]) => new MatrixEvent({ type, state_key: type, room_id: roomId, sender: USER, content }),
        ),
    );
    return room;
};

const NOT_GATED: VerjiGateDecision = { verdict: VerjiGateVerdict.NotGated };

describe("useVerjiGate", () => {
    let client: MatrixClient;

    beforeEach(() => {
        client = getMockClientWithEventEmitter(mockClientMethodsUser(USER));
        jest.spyOn(SpaceStore.instance, "spacePanelSpaces", "get").mockReturnValue([]);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    const contextsSeenBy = (gate: jest.Mock): Array<VerjiSpaceContext | null> => gate.mock.calls.map(([ctx]) => ctx);

    it("resolves the context from the space it renders, not the globally active space", () => {
        // The room list renders aux buttons for spaces that are not the active one; keying by the
        // active space would decide one tenant's affordances with another tenant's roles.
        const rendered = makeSpace(client, "!rendered:domain.org", {
            "app.verji.tenant_info": { tenant_id: "tenant-A" },
        });
        const active = makeSpace(client, "!active:domain.org", {
            "app.verji.tenant_info": { tenant_id: "tenant-B" },
        });
        jest.spyOn(SpaceStore.instance, "activeSpaceRoom", "get").mockReturnValue(active);
        const gate = jest.fn().mockReturnValue(NOT_GATED);

        renderHook(() => useVerjiGate(rendered, gate));

        expect(gate).toHaveBeenCalled();
        expect(new Set(contextsSeenBy(gate).map((ctx) => ctx?.tenantId))).toEqual(new Set(["tenant-A"]));
    });

    it("hands the gate the bridge store as its reader", () => {
        const gate = jest.fn().mockReturnValue(NOT_GATED);

        renderHook(() => useVerjiGate(null, gate));

        expect(gate).toHaveBeenCalledWith(null, VerjiPermissionsStore.instance);
    });

    describe("the top-level input to the pre-split kind fallback", () => {
        // A space with a canonical parent pointer is an OrgUnitCategory, unless it is a root of the
        // client's space tree, in which case it is a pre-split tenant-root mirror.
        const withParentPointer = (): Room =>
            makeSpace(client, "!personal-space:domain.org", {
                "app.verji.tenant_info": { tenant_id: "tenant-A" },
                "app.verji.canonical_parent_space": { canonical_parent_space_id: "!canonical:domain.org" },
            });

        it("reads a space in the space panel as a TenantRoot", () => {
            const space = withParentPointer();
            jest.spyOn(SpaceStore.instance, "spacePanelSpaces", "get").mockReturnValue([space]);
            const gate = jest.fn().mockReturnValue(NOT_GATED);

            renderHook(() => useVerjiGate(space, gate));

            expect(contextsSeenBy(gate)[0]?.kind).toBe(VerjiSpaceKind.TenantRoot);
        });

        it("reads the same space outside the space panel as an OrgUnitCategory", () => {
            const space = withParentPointer();
            const gate = jest.fn().mockReturnValue(NOT_GATED);

            renderHook(() => useVerjiGate(space, gate));

            expect(contextsSeenBy(gate)[0]?.kind).toBe(VerjiSpaceKind.OrgUnitCategory);
        });
    });

    describe("reactivity", () => {
        const denied: VerjiGateDecision = { verdict: VerjiGateVerdict.Denied, hint: "no" };

        it("re-evaluates the gate when the store changes, and returns the new decision", () => {
            const gate = jest.fn().mockReturnValue(NOT_GATED);
            const { result } = renderHook(() => useVerjiGate(null, gate));
            expect(result.current).toEqual(NOT_GATED);

            gate.mockReturnValue(denied);
            act(() => {
                VerjiPermissionsStore.instance["bumpVersion"]();
            });

            expect(result.current).toEqual(denied);
        });

        it("stops listening once unmounted", () => {
            // Asserted on the store's listener set: a state update on an unmounted component is
            // silently dropped, so watching the gate would pass whether or not the hook unsubscribed.
            const listeners = VerjiPermissionsStore.instance["changeListeners"];
            const before = listeners.size;
            const { unmount } = renderHook(() => useVerjiGate(null, jest.fn().mockReturnValue(NOT_GATED)));
            expect(listeners.size).toBe(before + 1);

            unmount();

            expect(listeners.size).toBe(before);
        });
    });

    /**
     * verji/verji-src#1507. A gate is a pure function evaluated during render and the SDK's read
     * path never fetches, so the hook's requests to the store must come from an effect, after the
     * render that read the gate.
     */
    describe("freshness requests", () => {
        const TENANT = "tenant-A";
        const ORG_A = "org-a";
        const CHECKING: VerjiGateDecision = { verdict: VerjiGateVerdict.Checking, hint: "checking" };

        const orgUnitSpace = (): Room =>
            makeSpace(client, "!org-unit:domain.org", {
                "app.verji.tenant_info": { tenant_id: TENANT },
                "app.verji.org_unit_info": { org_unit_id: ORG_A },
                "app.verji.canonical_parent_space": { canonical_parent_space_id: "!category:domain.org" },
            });

        const Probe: React.FC<{ space: Room | null; gate: jest.Mock }> = ({ space, gate }) => {
            useVerjiGate(space, gate);
            return null;
        };

        /**
         * Server rendering runs the render pass alone, with no effect after it — so whatever the
         * store is asked here, it was asked during render.
         */
        const renderOnly = (space: Room | null, gate: jest.Mock): void => {
            renderToString(<Probe space={space} gate={gate} />);
            expect(gate).toHaveBeenCalled();
        };

        let refresh: jest.SpyInstance;
        let revalidate: jest.SpyInstance;

        beforeEach(() => {
            refresh = jest.spyOn(VerjiPermissionsStore.instance, "requestOrgUnitRefresh").mockImplementation(() => {});
            revalidate = jest.spyOn(VerjiPermissionsStore.instance, "revalidateIfStale").mockImplementation(() => {});
        });

        it("asks for a re-fetch of the OrgUnit after a render that reads Checking, never during it", () => {
            const space = orgUnitSpace();
            const gate = jest.fn().mockReturnValue(CHECKING);

            renderOnly(space, gate);
            expect(refresh).not.toHaveBeenCalled();

            renderHook(() => useVerjiGate(space, gate));
            expect(refresh).toHaveBeenCalledWith(TENANT, ORG_A);
        });

        it.each([
            ["NotGated", { verdict: VerjiGateVerdict.NotGated }],
            ["Allowed", { verdict: VerjiGateVerdict.Allowed }],
            ["Denied", { verdict: VerjiGateVerdict.Denied, hint: "no" }],
            ["Hidden", { verdict: VerjiGateVerdict.Hidden }],
        ])("asks for no re-fetch when the gate reads %s", (_name, decision) => {
            renderHook(() => useVerjiGate(orgUnitSpace(), jest.fn().mockReturnValue(decision)));

            expect(refresh).not.toHaveBeenCalled();
        });

        it("asks to revalidate the rendered space's tenant after render, never during it", () => {
            const space = orgUnitSpace();
            const gate = jest.fn().mockReturnValue(NOT_GATED);

            renderOnly(space, gate);
            expect(revalidate).not.toHaveBeenCalled();

            renderHook(() => useVerjiGate(space, gate));
            expect(revalidate).toHaveBeenCalledWith(TENANT);
        });

        it("asks again after a later render, since the copy may have aged since the last one", () => {
            renderHook(() => useVerjiGate(orgUnitSpace(), jest.fn().mockReturnValue(NOT_GATED)));
            const callsAfterMount = revalidate.mock.calls.length;

            act(() => {
                VerjiPermissionsStore.instance["bumpVersion"]();
            });

            expect(revalidate.mock.calls.length).toBeGreaterThan(callsAfterMount);
        });

        it("asks for nothing when the rendered room is not a Verji space", () => {
            renderHook(() => useVerjiGate(null, jest.fn().mockReturnValue(CHECKING)));

            expect(refresh).not.toHaveBeenCalled();
            expect(revalidate).not.toHaveBeenCalled();
        });
    });
});
