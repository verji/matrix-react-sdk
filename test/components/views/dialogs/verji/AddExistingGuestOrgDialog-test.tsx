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
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClientEvent, MatrixClient, Room, RoomStateEvent } from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { mocked } from "jest-mock";

import type { OrgUnit } from "@verji/verji-api-sdk";
import { mkEvent, mockStateEventImplementation, stubClient } from "../../../../test-utils";
import AddExistingGuestOrgDialog from "../../../../../src/components/views/dialogs/verji/AddExistingGuestOrgDialog";
import { showAddExistingRoomToOrgUnitDialog } from "../../../../../src/components/views/dialogs/verji/AddExistingRoomToOrgUnitDialog";
import {
    assignDefaultOrgUnitCategory,
    getOrgUnitsWithoutCategory,
} from "../../../../../src/stores/verji/verjiOrgUnitRooms";
import { VerjiPermissionsStore } from "../../../../../src/stores/verji/VerjiPermissionsStore";

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

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
}

const deferred = <T,>(): Deferred<T> => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
};

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

    const addButton = (orgUnitId: string): HTMLElement =>
        within(screen.getByTestId(`verji-guest-org-${orgUnitId}`)).getByRole("button");
    /** Type a search in one change, which the search box passes on at once. */
    const search = (query: string): void => {
        fireEvent.change(screen.getByPlaceholderText("Search guest organizations"), { target: { value: query } });
    };
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

    it("lists the tenant's guest orgs that have no category that the user may bring in, by name", async () => {
        renderDialog();

        const rows = await screen.findAllByTestId(/^verji-guest-org-org-/);
        // Which ones the user may bring in is read from their access context.
        expect(getOrgUnitsWithoutCategory).toHaveBeenCalledWith(client, TENANT, VerjiPermissionsStore.instance);
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

    it("sees the space arrive as room state too, on a room the client already has", async () => {
        const space = makeSpace("!kari:server", TENANT, "org-a");
        renderDialog();

        await clickAdd("org-a");
        expect(screen.getByTestId("verji-guest-org-waiting")).toBeInTheDocument();

        // The room was there already; its org_unit_info is what arrives.
        rooms = [space];
        const orgUnitInfo = space.currentState.getStateEvents("app.verji.org_unit_info", "app.verji.org_unit_info");
        act(() => {
            client.emit(RoomStateEvent.Events, orgUnitInfo!, space.currentState, null);
        });

        expect(await screen.findByTestId("verji-guest-org-ready")).toBeInTheDocument();
    });

    it("sends one request for a double click, and offers no other guest org meanwhile", async () => {
        mocked(assignDefaultOrgUnitCategory).mockReturnValue(new Promise(() => {}));
        renderDialog();
        await screen.findByTestId("verji-guest-org-org-a");

        const button = addButton("org-a");
        fireEvent.click(button);
        fireEvent.click(button);
        fireEvent.keyDown(button, { key: "Enter" });

        expect(assignDefaultOrgUnitCategory).toHaveBeenCalledTimes(1);
        expect(addButton("org-b")).toHaveAttribute("aria-disabled", "true");
    });

    it("goes back to the list with a message when bringing one in fails", async () => {
        mocked(assignDefaultOrgUnitCategory).mockRejectedValue(new Error("forbidden"));
        renderDialog();

        await clickAdd("org-a");

        expect(await screen.findByText("Kari AS could not be added. Try again.")).toBeInTheDocument();
        expect(addButton("org-a")).not.toHaveAttribute("aria-disabled", "true");
        expect(addButton("org-b")).not.toHaveAttribute("aria-disabled", "true");
    });

    it("says the list could not be loaded, and retries", async () => {
        mocked(getOrgUnitsWithoutCategory).mockRejectedValueOnce(new Error("forbidden"));
        renderDialog();

        expect(await screen.findByText("Could not load the list. Try again.")).toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(await screen.findByTestId("verji-guest-org-org-a")).toBeInTheDocument();
        expect(getOrgUnitsWithoutCategory).toHaveBeenCalledTimes(2);
    });

    it("filters the guest orgs by name, and says 'No results' when none matches", async () => {
        renderDialog();
        await screen.findByTestId("verji-guest-org-org-a");

        search("ola");

        expect(screen.getByTestId("verji-guest-org-org-b")).toBeInTheDocument();
        expect(screen.queryByTestId("verji-guest-org-org-a")).not.toBeInTheDocument();

        search("nothing like it");

        expect(await screen.findByText("No results")).toBeInTheDocument();
        expect(screen.queryByText("There are no guest organizations left to add.")).not.toBeInTheDocument();
    });

    it("says so when every guest org is in", async () => {
        mocked(getOrgUnitsWithoutCategory).mockResolvedValue([]);
        renderDialog();

        expect(await screen.findByText("There are no guest organizations left to add.")).toBeInTheDocument();
        expect(screen.queryByText("No results")).not.toBeInTheDocument();
    });

    describe("once closed", () => {
        let errors: jest.SpyInstance;
        /** React's warning for a state update on an unmounted component. */
        const updatesAfterUnmount = (): unknown[][] =>
            errors.mock.calls.filter((call) => String(call[0]).includes("unmounted component"));

        beforeEach(() => {
            errors = jest.spyOn(console, "error");
        });

        afterEach(() => errors.mockRestore());

        it.each([
            [
                "the list arrives",
                (list: Deferred<OrgUnit[]>) =>
                    list.resolve([{ id: "org-a", name: "Kari AS", orgUnitCategoryId: null }]),
            ],
            ["the list fails", (list: Deferred<OrgUnit[]>) => list.reject(new Error("down"))],
        ])("changes nothing when %s", async (_what, settle) => {
            const list = deferred<OrgUnit[]>();
            mocked(getOrgUnitsWithoutCategory).mockReturnValue(list.promise);
            const { unmount } = renderDialog();

            unmount();
            await act(async () => {
                settle(list);
                await list.promise.catch(() => undefined);
            });

            expect(updatesAfterUnmount()).toEqual([]);
        });

        it.each([
            ["the guest org is brought in", (answer: Deferred<void>) => answer.resolve()],
            ["bringing it in fails", (answer: Deferred<void>) => answer.reject(new Error("down"))],
        ])("changes nothing when %s", async (_what, settle) => {
            const answer = deferred<void>();
            mocked(assignDefaultOrgUnitCategory).mockReturnValue(answer.promise);
            const { unmount } = renderDialog();
            await screen.findByTestId("verji-guest-org-org-a");

            fireEvent.click(addButton("org-a"));
            unmount();
            await act(async () => {
                settle(answer);
                await answer.promise.catch(() => undefined);
            });

            expect(updatesAfterUnmount()).toEqual([]);
        });
    });
});
