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
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MatrixClient } from "matrix-js-sdk/src/matrix";
import { mocked } from "jest-mock";
import { OrgUnitRoomConflictError } from "@verji/verji-api-sdk";

import type { OrgUnitRoomCandidate } from "@verji/verji-api-sdk";
import { stubClient } from "../../../../test-utils";
import AddExistingRoomToOrgUnitDialog from "../../../../../src/components/views/dialogs/verji/AddExistingRoomToOrgUnitDialog";
import { assignRoomToOrgUnit, getOrgUnitRoomCandidates } from "../../../../../src/stores/verji/verjiOrgUnitRooms";

// VERJI: verji/verji-src#2117 — the Organization API calls are mocked; reading a conflict's reason is not.
jest.mock("../../../../../src/stores/verji/verjiOrgUnitRooms", () => ({
    ...jest.requireActual("../../../../../src/stores/verji/verjiOrgUnitRooms"),
    getOrgUnitRoomCandidates: jest.fn(),
    assignRoomToOrgUnit: jest.fn(),
}));

const candidate = (
    roomId: string,
    name: string,
    fit: OrgUnitRoomCandidate["fit"],
    reason: OrgUnitRoomCandidate["reason"] = null,
): OrgUnitRoomCandidate => ({ roomId, name, fit, reason });

const SUGGESTED = candidate("!suggested:server", "Project Kari", "Suggested");
const INTERNAL = candidate("!internal:server", "Board", "Internal");
const REFUSED = candidate("!refused:server", "Mixed room", "Refused", "MemberOutsideOrgUnit");

describe("<AddExistingRoomToOrgUnitDialog />", () => {
    let client: MatrixClient;
    const onFinished = jest.fn();

    const renderDialog = () =>
        render(
            <AddExistingRoomToOrgUnitDialog
                client={client}
                tenantId="tenant-1"
                tenantName="Acme AS"
                orgUnitId="org-a"
                orgUnitName="Kari AS"
                onFinished={onFinished}
            />,
        );

    const row = (roomId: string): HTMLElement => screen.getByTestId(`verji-room-candidate-${roomId}`);
    const addButton = (roomId: string): HTMLElement => within(row(roomId)).getByRole("button");
    /** Click a room's Add, and let the assignment it starts settle inside act. */
    const clickAdd = async (roomId: string): Promise<void> => {
        await act(async () => {
            await userEvent.click(addButton(roomId));
        });
    };

    beforeEach(() => {
        client = stubClient();
        jest.spyOn(client, "getRoom").mockReturnValue(null);
        mocked(getOrgUnitRoomCandidates).mockReset().mockResolvedValue([REFUSED, INTERNAL, SUGGESTED]);
        mocked(assignRoomToOrgUnit).mockReset().mockResolvedValue(undefined);
        onFinished.mockReset();
    });

    it("lists the suggested rooms first, keeps internal ones behind 'Show all rooms', and refused ones last, disabled", async () => {
        renderDialog();

        const suggested = await screen.findByTestId("verji-room-candidates-suggested");
        expect(getOrgUnitRoomCandidates).toHaveBeenCalledWith(client, "tenant-1", "org-a");
        expect(within(suggested).getByText("Project Kari")).toBeInTheDocument();
        expect(screen.queryByTestId("verji-room-candidates-internal")).not.toBeInTheDocument();
        expect(screen.queryByText("Board")).not.toBeInTheDocument();

        const refused = screen.getByTestId("verji-room-candidates-refused");
        expect(within(refused).getByText("Mixed room")).toBeInTheDocument();
        expect(addButton(REFUSED.roomId)).toHaveAttribute("aria-disabled", "true");
        expect(row(REFUSED.roomId)).toHaveTextContent(
            "Someone in this room is not part of Kari AS or Acme AS, so it cannot be added.",
        );
        expect(addButton(SUGGESTED.roomId)).not.toHaveAttribute("aria-disabled", "true");

        await userEvent.click(screen.getByRole("button", { name: "Show all rooms" }));

        const internal = screen.getByTestId("verji-room-candidates-internal");
        expect(within(internal).getByText("Board")).toBeInTheDocument();
        expect(within(internal).getByText("Only people from Acme AS")).toBeInTheDocument();
        // Suggested, then internal, then refused.
        const sections = screen.getAllByTestId(/^verji-room-candidates-/).map((s) => s.dataset.testid);
        expect(sections).toEqual([
            "verji-room-candidates-suggested",
            "verji-room-candidates-internal",
            "verji-room-candidates-refused",
        ]);
    });

    it("does not offer 'Show all rooms' when there are no internal rooms", async () => {
        mocked(getOrgUnitRoomCandidates).mockResolvedValue([SUGGESTED]);
        renderDialog();

        await screen.findByTestId("verji-room-candidates-suggested");
        expect(screen.queryByRole("button", { name: "Show all rooms" })).not.toBeInTheDocument();
    });

    it("never assigns a refused room", async () => {
        renderDialog();

        await userEvent.click(await screen.findByText("Mixed room"));
        await clickAdd(REFUSED.roomId);

        expect(assignRoomToOrgUnit).not.toHaveBeenCalled();
    });

    it("assigns the chosen room through the Organization API, and marks it added", async () => {
        renderDialog();

        await screen.findByTestId("verji-room-candidates-suggested");
        await clickAdd(SUGGESTED.roomId);

        expect(assignRoomToOrgUnit).toHaveBeenCalledWith(client, "tenant-1", "org-a", SUGGESTED.roomId);
        expect(addButton(SUGGESTED.roomId)).toHaveTextContent("Added");
        expect(addButton(SUGGESTED.roomId)).toHaveAttribute("aria-disabled", "true");

        await userEvent.click(screen.getByRole("button", { name: "Done" }));
        expect(onFinished).toHaveBeenCalledWith(true);
    });

    it.each([
        ["MemberOutsideOrgUnit", "Someone in this room is not part of Kari AS or Acme AS, so it cannot be added."],
        ["AlreadyInOrgUnit", "This room is already in a guest organization."],
        ["CallerNotInRoom", "You are no longer in this room."],
        ["NotInTenant", "This room does not belong to Acme AS."],
        ["NotARoom", "Only rooms can be added, not spaces or direct messages."],
        ["OrgUnitHasNoSpace", "Kari AS does not have its space yet. Try again in a moment."],
        ["SomethingNew", "The room could not be added. Try again."],
    ])("shows a 409 with reason %s as a readable message on the room, and disables it", async (reason, message) => {
        mocked(assignRoomToOrgUnit).mockRejectedValue(new OrgUnitRoomConflictError(reason));
        renderDialog();

        await screen.findByTestId("verji-room-candidates-suggested");
        await clickAdd(SUGGESTED.roomId);

        expect(await within(row(SUGGESTED.roomId)).findByText(message)).toBeInTheDocument();
        expect(addButton(SUGGESTED.roomId)).toHaveTextContent("Add");
        expect(addButton(SUGGESTED.roomId)).toHaveAttribute("aria-disabled", "true");
    });

    it("keeps a room that failed for another reason available, with a general message", async () => {
        mocked(assignRoomToOrgUnit).mockRejectedValueOnce(new Error("network down"));
        renderDialog();

        await screen.findByTestId("verji-room-candidates-suggested");
        await clickAdd(SUGGESTED.roomId);

        expect(screen.getByText("The room could not be added. Try again.")).toBeInTheDocument();
        expect(addButton(SUGGESTED.roomId)).not.toHaveAttribute("aria-disabled", "true");
    });

    it("says why when the guest org has no space yet", async () => {
        mocked(getOrgUnitRoomCandidates).mockRejectedValue(new OrgUnitRoomConflictError("OrgUnitHasNoSpace"));
        renderDialog();

        expect(
            await screen.findByText("Kari AS does not have its space yet. Try again in a moment."),
        ).toBeInTheDocument();
    });

    it("says so when none of the caller's rooms can be added", async () => {
        mocked(getOrgUnitRoomCandidates).mockResolvedValue([]);
        renderDialog();

        expect(await screen.findByText("None of your rooms can be added to Kari AS.")).toBeInTheDocument();
    });
});
