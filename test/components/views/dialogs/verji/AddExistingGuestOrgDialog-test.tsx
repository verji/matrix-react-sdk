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
import { ClientEvent, MatrixClient, Room } from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { mocked } from "jest-mock";

import { mkEvent, mockStateEventImplementation, stubClient } from "../../../../test-utils";
import AddExistingGuestOrgDialog from "../../../../../src/components/views/dialogs/verji/AddExistingGuestOrgDialog";
import { showAddExistingRoomToOrgUnitDialog } from "../../../../../src/components/views/dialogs/verji/AddExistingRoomToOrgUnitDialog";
import {
    assignDefaultOrgUnitCategory,
    getOrgUnitsWithoutCategory,
} from "../../../../../src/stores/verji/verjiOrgUnitRooms";

// VERJI: verji/verji-src#2117 — the Organization API calls are mocked; finding the space is not.
jest.mock("../../../../../src/stores/verji/verjiOrgUnitRooms", () => ({
    ...jest.requireActual("../../../../../src/stores/verji/verjiOrgUnitRooms"),
    getOrgUnitsWithoutCategory: jest.fn(),
    assignDefaultOrgUnitCategory: jest.fn(),
}));
jest.mock("../../../../../src/components/views/dialogs/verji/AddExistingRoomToOrgUnitDialog", () => ({
    showAddExistingRoomToOrgUnitDialog: jest.fn(),
}));

const TENANT = "tenant-1";

/** A joined space carrying the Verji state a guest org's personal space carries. */
const makeSpace = (roomId: string, tenantId: string, orgUnitId: string): Room => {
    const state = [
        mkEvent({
            event: true,
            type: "app.verji.tenant_info",
            skey: "app.verji.tenant_info",
            room: roomId,
            user: "@vsys:server",
            content: { tenant_id: tenantId },
        }),
        mkEvent({
            event: true,
            type: "app.verji.org_unit_info",
            skey: "app.verji.org_unit_info",
            room: roomId,
            user: "@vsys:server",
            content: { org_unit_id: orgUnitId },
        }),
    ];
    return {
        roomId,
        name: "Kari AS",
        isSpaceRoom: () => true,
        getMyMembership: () => KnownMembership.Join,
        currentState: { getStateEvents: jest.fn().mockImplementation(mockStateEventImplementation(state)) },
    } as unknown as Room;
};

describe("<AddExistingGuestOrgDialog />", () => {
    let client: MatrixClient;
    let rooms: Room[];
    const onFinished = jest.fn();

    const renderDialog = () =>
        render(
            <AddExistingGuestOrgDialog
                client={client}
                tenantId={TENANT}
                tenantName="Acme AS"
                onFinished={onFinished}
            />,
        );

    /** Click a guest org's Add, and let what it starts settle inside act. */
    const clickAdd = async (orgUnitId: string): Promise<void> => {
        const button = within(await screen.findByTestId(`verji-guest-org-${orgUnitId}`)).getByRole("button");
        await act(async () => {
            await userEvent.click(button);
        });
    };

    beforeEach(() => {
        client = stubClient();
        rooms = [];
        mocked(client.getRooms).mockImplementation(() => rooms);
        mocked(getOrgUnitsWithoutCategory)
            .mockReset()
            .mockResolvedValue([
                { id: "org-b", name: "Ola AS", orgUnitCategoryId: null },
                { id: "org-a", name: "Kari AS", orgUnitCategoryId: null },
            ]);
        mocked(assignDefaultOrgUnitCategory).mockReset().mockResolvedValue(undefined);
        mocked(showAddExistingRoomToOrgUnitDialog).mockReset();
        onFinished.mockReset();
    });

    it("lists the tenant's guest orgs that have no category, by name", async () => {
        renderDialog();

        const rows = await screen.findAllByTestId(/^verji-guest-org-org-/);
        expect(getOrgUnitsWithoutCategory).toHaveBeenCalledWith(client, TENANT);
        expect(rows.map((r) => r.textContent)).toEqual(["Kari ASAdd", "Ola ASAdd"]);
    });

    it("brings the chosen one in, waits for its space, then offers to add its rooms", async () => {
        renderDialog();

        await clickAdd("org-a");

        expect(assignDefaultOrgUnitCategory).toHaveBeenCalledWith(client, TENANT, "org-a");
        expect(await screen.findByTestId("verji-guest-org-waiting")).toHaveTextContent("Adding Kari AS.");

        // A space of another guest org, and one of another tenant, are not the one.
        rooms = [
            makeSpace("!other-org:server", TENANT, "org-b"),
            makeSpace("!other-tenant:server", "tenant-2", "org-a"),
        ];
        act(() => {
            client.emit(ClientEvent.Room, rooms[0]);
        });
        expect(screen.getByTestId("verji-guest-org-waiting")).toBeInTheDocument();

        const space = makeSpace("!kari:server", TENANT, "org-a");
        rooms = [...rooms, space];
        act(() => {
            client.emit(ClientEvent.Room, space);
        });

        expect(await screen.findByTestId("verji-guest-org-ready")).toHaveTextContent(
            "Kari AS has its space now. Add the rooms that belong to it?",
        );
        await userEvent.click(screen.getByRole("button", { name: "Add existing rooms" }));
        expect(onFinished).toHaveBeenCalled();
        expect(showAddExistingRoomToOrgUnitDialog).toHaveBeenCalledWith(space);
    });

    it("goes back to the list with a message when bringing one in fails", async () => {
        mocked(assignDefaultOrgUnitCategory).mockRejectedValue(new Error("forbidden"));
        renderDialog();

        await clickAdd("org-a");

        expect(await screen.findByText("Kari AS could not be added. Try again.")).toBeInTheDocument();
        expect(screen.getByTestId("verji-guest-org-org-a")).toBeInTheDocument();
    });

    it("says so when every guest org is in", async () => {
        mocked(getOrgUnitsWithoutCategory).mockResolvedValue([]);
        renderDialog();

        expect(await screen.findByText("There are no guest organizations left to add.")).toBeInTheDocument();
    });
});
