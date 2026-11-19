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
import { mocked } from "jest-mock";
import { act, fireEvent, render, RenderResult, screen } from "@testing-library/react";
import { EventType, MatrixClient, MatrixEvent, Room } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import SpaceSettingsGeneralTab, {
    SLOW_RENAME_MS,
} from "../../../../src/components/views/spaces/SpaceSettingsGeneralTab";
import { _t } from "../../../../src/languageHandler";
import SpaceStore from "../../../../src/stores/spaces/SpaceStore";
import { VerjiPermissionsStore } from "../../../../src/stores/verji/VerjiPermissionsStore";
import { OrgUnitRenameOutcome, setOrgUnitNameThroughVerji } from "../../../../src/stores/verji/verjiOrgUnitName";
import { flushPromises, getMockClientWithEventEmitter, mockClientMethodsUser } from "../../../test-utils";

jest.mock("../../../../src/stores/verji/verjiOrgUnitName", () => ({
    ...jest.requireActual("../../../../src/stores/verji/verjiOrgUnitName"),
    setOrgUnitNameThroughVerji: jest.fn(),
}));

const USER = "@owner:server";
const ROOM_ID = "!personal-space:server";
const TENANT = "tenant-1";
const ORG_A = "org-a";
const STANDARD_USER = { "Customer-User#": [TENANT] };
const OWNER = { ...STANDARD_USER, "ClientOrganization-Owner": [ORG_A] };
const MEMBER = { ...STANDARD_USER, "ClientOrganization-User#": [ORG_A] };

/**
 * VERJI: verji/verji-src#2377. A guest org's space is renamed by renaming the guest org through the
 * Verji API, by whoever the space name gate allows; Matrix power levels decide only outside it.
 */
describe("<SpaceSettingsGeneralTab />", () => {
    let client: MatrixClient;
    let space: Room;

    const stateEvent = (type: string, content: object, stateKey = type): MatrixEvent =>
        new MatrixEvent({ type, state_key: stateKey, room_id: ROOM_ID, sender: "@vsys:server", content });

    /** The guest org's space as a person holds it: a personal space whose name only `vsys` may change. */
    const makeGuestOrgSpace = (): Room => {
        const room = new Room(ROOM_ID, client, USER);
        room.currentState.setStateEvents([
            stateEvent(EventType.RoomCreate, { type: "m.space", creator: "@vsys:server" }, ""),
            stateEvent(EventType.RoomName, { name: "Old name" }, ""),
            stateEvent("app.verji.tenant_info", { tenant_id: TENANT }),
            stateEvent("app.verji.canonical_parent_space", { canonical_parent_space_id: "!parent:server" }),
            stateEvent("app.verji.org_unit_info", { org_unit_id: ORG_A, org_unit_name: "Old name" }),
        ]);
        room.recalculate();
        jest.spyOn(room.currentState, "maySendStateEvent").mockReturnValue(false);
        return room;
    };

    /** The copy of the new name arriving in the space, written by `vsys`. */
    const nameArrives = (name: string): void => {
        act(() => {
            space.currentState.setStateEvents([stateEvent(EventType.RoomName, { name }, "")]);
            space.recalculate();
        });
    };

    const mockStore = (rolloutOn: boolean, grants: Record<string, string[]>, organizationService = true): void => {
        const store = VerjiPermissionsStore.instance;
        jest.spyOn(store, "isCanonicalSpaceSyncEnabled").mockImplementation((t) => rolloutOn && t === TENANT);
        jest.spyOn(store, "hasRole").mockImplementation(
            (t, role, instance) => t === TENANT && (grants[role] ?? []).includes(instance),
        );
        jest.spyOn(store, "isInstanceReferenced").mockImplementation(
            (t, instance) => t === TENANT && Object.values(grants).some((instances) => instances.includes(instance)),
        );
        jest.spyOn(store, "isOrgUnitRefreshExhausted").mockReturnValue(false);
        jest.spyOn(store, "isOrganizationServiceAvailable").mockReturnValue(organizationService);
        jest.spyOn(store, "watchTenant").mockReturnValue(jest.fn());
        jest.spyOn(store, "refreshTenant").mockImplementation(() => {});
    };

    const renderTab = (): RenderResult => render(<SpaceSettingsGeneralTab matrixClient={client} space={space} />);
    /** Save, flushing with fake timers, which would never run flushPromises' own timer. */
    const saveWithFakeTimers = async (): Promise<void> => {
        await act(async () => {
            fireEvent.click(screen.getByText(_t("room_settings|general|save")));
            await jest.advanceTimersByTimeAsync(0);
        });
    };
    const nameField = (): HTMLInputElement => screen.getByLabelText(_t("common|name")) as HTMLInputElement;
    const typeName = (name: string): void => {
        fireEvent.change(nameField(), { target: { value: name } });
    };
    const save = async (): Promise<void> => {
        await act(async () => {
            fireEvent.click(screen.getByText(_t("room_settings|general|save")));
            await flushPromises();
        });
    };

    beforeEach(() => {
        client = getMockClientWithEventEmitter({
            ...mockClientMethodsUser(USER),
            setRoomName: jest.fn().mockResolvedValue({}),
            setRoomTopic: jest.fn().mockResolvedValue({}),
            sendStateEvent: jest.fn().mockResolvedValue({}),
        });
        space = makeGuestOrgSpace();
        jest.spyOn(SpaceStore.instance, "spacePanelSpaces", "get").mockReturnValue([]);
        mocked(setOrgUnitNameThroughVerji).mockResolvedValue(OrgUnitRenameOutcome.Accepted);
        // A refused rename is logged as a failed save; the tests assert what the user is told instead.
        jest.spyOn(logger, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
        mocked(setOrgUnitNameThroughVerji).mockReset();
    });

    it("lets the guest org's Owner change the name, though Matrix would not, up to 255 characters", () => {
        mockStore(true, OWNER);
        renderTab();

        expect(nameField()).not.toBeDisabled();
        expect(nameField()).toHaveAttribute("maxLength", "255");
    });

    it("saves the name by renaming the guest org, never through Matrix, and says it is on its way", async () => {
        mockStore(true, OWNER);
        renderTab();

        typeName("  New name ");
        await save();

        expect(setOrgUnitNameThroughVerji).toHaveBeenCalledWith(client, TENANT, ORG_A, "  New name ");
        expect(client.setRoomName).not.toHaveBeenCalled();
        expect(screen.getByText(_t("verji|space_name|saved_pending"))).toBeInTheDocument();
        expect(screen.getByText(_t("room_settings|general|save"))).toHaveAttribute("aria-disabled", "true");
        expect(nameField()).toBeDisabled();

        nameArrives("New name");

        expect(screen.queryByText(_t("verji|space_name|saved_pending"))).not.toBeInTheDocument();
        expect(nameField()).toHaveValue("New name");
        expect(nameField()).not.toBeDisabled();
    });

    it("keeps waiting while another name arrives, and says so after 30 seconds", async () => {
        jest.useFakeTimers();
        mockStore(true, OWNER);
        renderTab();

        typeName("New name");
        // flushPromises waits on a timer, which fake timers would never run.
        await act(async () => {
            fireEvent.click(screen.getByText(_t("room_settings|general|save")));
            await jest.advanceTimersByTimeAsync(0);
        });
        nameArrives("Someone else's name");
        expect(screen.getByText(_t("verji|space_name|saved_pending"))).toBeInTheDocument();

        act(() => {
            jest.advanceTimersByTime(SLOW_RENAME_MS);
        });

        expect(screen.getByText(_t("verji|space_name|slow"))).toBeInTheDocument();
        expect(screen.queryByText(_t("verji|space_name|saved_pending"))).not.toBeInTheDocument();
    });

    it("unlocks the name, Save and Cancel once the rename is taking long, as the name may never come", async () => {
        jest.useFakeTimers();
        mockStore(true, OWNER);
        renderTab();

        typeName("New name");
        await saveWithFakeTimers();
        expect(nameField()).toBeDisabled();

        act(() => {
            jest.advanceTimersByTime(SLOW_RENAME_MS);
        });

        expect(screen.getByText(_t("verji|space_name|slow"))).toBeInTheDocument();
        expect(nameField()).not.toBeDisabled();
        expect(screen.getByText(_t("room_settings|general|save"))).not.toHaveAttribute("aria-disabled", "true");

        // Cancel puts the space's name back and drops the note.
        fireEvent.click(screen.getByText(_t("action|cancel")));
        expect(nameField()).toHaveValue("Old name");
        expect(screen.queryByText(_t("verji|space_name|slow"))).not.toBeInTheDocument();
    });

    it("waits for nothing when only whitespace changed, since the server then writes no name", async () => {
        mockStore(true, OWNER);
        renderTab();

        typeName("Old name  ");
        await save();

        expect(setOrgUnitNameThroughVerji).toHaveBeenCalledWith(client, TENANT, ORG_A, "Old name  ");
        expect(screen.queryByText(_t("verji|space_name|saved_pending"))).not.toBeInTheDocument();
        expect(nameField()).toHaveValue("Old name");
        expect(nameField()).not.toBeDisabled();
    });

    it("waits for nothing when the new name arrived before the answer", async () => {
        mockStore(true, OWNER);
        mocked(setOrgUnitNameThroughVerji).mockImplementation(async () => {
            // The copy, written by vsys, synced before the Organization API answered.
            space.currentState.setStateEvents([stateEvent(EventType.RoomName, { name: "New name" }, "")]);
            space.recalculate();
            return OrgUnitRenameOutcome.Accepted;
        });
        renderTab();

        typeName("New name");
        await save();

        expect(screen.queryByText(_t("verji|space_name|saved_pending"))).not.toBeInTheDocument();
        expect(nameField()).toHaveValue("New name");
        expect(nameField()).not.toBeDisabled();
    });

    it("does not send a name once the gate no longer allows it, and says why", async () => {
        mockStore(true, OWNER);
        const { container, rerender } = renderTab();
        typeName("New name");

        // A fresh access context lands while the name is typed: the user is now a plain Member.
        mockStore(true, MEMBER);
        rerender(<SpaceSettingsGeneralTab matrixClient={client} space={space} />);
        await save();

        expect(setOrgUnitNameThroughVerji).not.toHaveBeenCalled();
        expect(container.querySelector(".mx_SpaceRoomView_errorText")?.textContent).toBe(
            _t("verji|gate|space_name_denied_not_org_owner_or_primary_contact"),
        );
    });

    it.each([
        [OrgUnitRenameOutcome.Invalid, "verji|space_name|invalid"],
        [OrgUnitRenameOutcome.NoLongerAllowed, "verji|space_name|no_longer_allowed"],
        [OrgUnitRenameOutcome.RateLimited, "verji|space_name|rate_limited"],
        [OrgUnitRenameOutcome.Failed, "room_settings|general|error_save_space_settings"],
    ] as const)("says why a rename came back %s", async (outcome, message) => {
        mockStore(true, OWNER);
        mocked(setOrgUnitNameThroughVerji).mockResolvedValue(outcome);
        renderTab();

        typeName("New name");
        await save();

        expect(screen.getByText(_t(message))).toBeInTheDocument();
        expect(screen.queryByText(_t("verji|space_name|saved_pending"))).not.toBeInTheDocument();
        expect(screen.getByText(_t("room_settings|general|save"))).not.toHaveAttribute("aria-disabled", "true");
    });

    it("refreshes the access context when the server says the user may no longer rename", async () => {
        mockStore(true, OWNER);
        mocked(setOrgUnitNameThroughVerji).mockResolvedValue(OrgUnitRenameOutcome.NoLongerAllowed);
        renderTab();

        typeName("New name");
        await save();

        expect(VerjiPermissionsStore.instance.refreshTenant).toHaveBeenCalledWith(TENANT);
    });

    it.each([
        ["blank", "   "],
        ["longer than 255 characters once trimmed", "n".repeat(256)],
    ])("refuses a %s name without asking the server", async (_what, name) => {
        mockStore(true, OWNER);
        renderTab();

        // The field holds 255 at most; a change event sets the value past that, as a paste could not.
        typeName(name);
        await save();

        expect(setOrgUnitNameThroughVerji).not.toHaveBeenCalled();
        expect(screen.getByText(_t("verji|space_name|invalid"))).toBeInTheDocument();
    });

    it("disables the name for a Member, with the reason", () => {
        mockStore(true, MEMBER);
        renderTab();

        expect(nameField()).toBeDisabled();
        expect(
            screen.getByText(_t("verji|gate|space_name_denied_not_org_owner_or_primary_contact")),
        ).toBeInTheDocument();
    });

    it("leaves the name to Matrix with the rollout switch off, as today", async () => {
        mockStore(false, OWNER);
        jest.spyOn(space.currentState, "maySendStateEvent").mockReturnValue(true);
        renderTab();

        expect(nameField()).not.toHaveAttribute("maxLength");
        typeName("New name");
        await save();

        expect(client.setRoomName).toHaveBeenCalledWith(ROOM_ID, "New name");
        expect(setOrgUnitNameThroughVerji).not.toHaveBeenCalled();
    });

    it("leaves the name to Matrix with no Organization service configured", () => {
        mockStore(true, OWNER, false);
        renderTab();

        // Matrix's rule: the person cannot send m.room.name in their personal space.
        expect(nameField()).toBeDisabled();
        expect(
            screen.queryByText(_t("verji|gate|space_name_denied_not_org_owner_or_primary_contact")),
        ).not.toBeInTheDocument();
    });
});
