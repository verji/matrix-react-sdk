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
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MatrixClient, PendingEventOrdering, Room } from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { mocked } from "jest-mock";
import { OrgUnitRoomConflictError } from "@verji/verji-api-sdk";

import type { OrgUnitRoomCandidate } from "@verji/verji-api-sdk";
import { mkEvent, mkMembership, mockStateEventImplementation, stubClient } from "../../../../test-utils";
import AddExistingRoomToOrgUnitDialog, {
    showAddExistingRoomToOrgUnitDialog,
} from "../../../../../src/components/views/dialogs/verji/AddExistingRoomToOrgUnitDialog";
import {
    assignRoomToOrgUnit,
    getOrgUnitName,
    getOrgUnitRoomCandidates,
} from "../../../../../src/stores/verji/verjiOrgUnitRooms";
import Modal from "../../../../../src/Modal";
import DMRoomMap from "../../../../../src/utils/DMRoomMap";

// VERJI: verji/verji-src#2117 — the Organization API calls are mocked; reading a conflict's reason, or a 403, is not.
jest.mock("../../../../../src/stores/verji/verjiOrgUnitRooms", () => ({
    ...jest.requireActual("../../../../../src/stores/verji/verjiOrgUnitRooms"),
    getOrgUnitRoomCandidates: jest.fn(),
    assignRoomToOrgUnit: jest.fn(),
    getOrgUnitName: jest.fn(),
}));

/** What the SDK passes on when the Organization API answers 403: the request's own error. */
const forbidden = (): Error =>
    Object.assign(new Error("Request failed with status code 403"), { response: { status: 403 } });

const candidate = (
    roomId: string,
    name: string | null,
    fit: OrgUnitRoomCandidate["fit"],
    reason: OrgUnitRoomCandidate["reason"] = null,
): OrgUnitRoomCandidate => ({ roomId, name, fit, reason });

const SUGGESTED = candidate("!suggested:server", "Project Kari", "Suggested");
const INTERNAL = candidate("!internal:server", "Board", "Internal");
const REFUSED = candidate("!refused:server", "Mixed room", "Refused", "MemberOutsideOrgUnit");

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
    /** Type a search in one change, which the search box passes on at once. */
    const search = (query: string): void => {
        fireEvent.change(screen.getByPlaceholderText("Search rooms"), { target: { value: query } });
    };

    beforeEach(() => {
        client = stubClient();
        jest.spyOn(client, "getRoom").mockReturnValue(null);
        mocked(getOrgUnitRoomCandidates).mockReset().mockResolvedValue([REFUSED, INTERNAL, SUGGESTED]);
        mocked(assignRoomToOrgUnit).mockReset().mockResolvedValue(undefined);
        mocked(getOrgUnitName).mockReset().mockResolvedValue("Kari AS");
        onFinished.mockReset();
    });

    /** A nameless room the client knows, whose name matrix-js-sdk makes up from its members: Eve, from outside. */
    const roomWithOutsider = (): Room => {
        const eve = "@eve:outside.example";
        const me = client.getSafeUserId();
        // Listed as fitting, its row shows the room's own avatar, which reads its pending events.
        const room = new Room("!mixed:server", client, me, { pendingEventOrdering: PendingEventOrdering.Detached });
        room.currentState.setStateEvents([
            mkMembership({ event: true, room: room.roomId, mship: KnownMembership.Join, user: me, skey: me }),
            mkMembership({
                event: true,
                room: room.roomId,
                mship: KnownMembership.Join,
                user: eve,
                skey: eve,
                name: "Eve Outsider",
                url: "mxc://outside.example/eve",
            }),
        ]);
        room.recalculate();
        expect(room.name).toContain("Eve Outsider");
        mocked(client.getRoom).mockImplementation((id) => (id === room.roomId ? room : null));
        // The room's own avatar asks whether it is a direct message: it is not.
        dmRoomMap = jest
            .spyOn(DMRoomMap, "shared")
            .mockReturnValue({ getUserIdForRoomId: () => undefined } as unknown as DMRoomMap);
        return room;
    };
    let dmRoomMap: jest.SpyInstance | undefined;
    afterEach(() => {
        dmRoomMap?.mockRestore();
        dmRoomMap = undefined;
    });

    it("takes nothing from the members of a room refused when it is chosen, though it was listed as fitting", async () => {
        const room = roomWithOutsider();
        // The list said Internal; by the time it is chosen, someone from outside is in it.
        mocked(getOrgUnitRoomCandidates).mockResolvedValue([candidate(room.roomId, null, "Internal")]);
        mocked(assignRoomToOrgUnit).mockRejectedValue(new OrgUnitRoomConflictError("MemberOutsideOrgUnit"));
        renderDialog();
        await userEvent.click(await screen.findByRole("button", { name: "Show all rooms" }));

        await clickAdd(room.roomId);

        const refused = row(room.roomId);
        expect(refused).toHaveTextContent(
            "Someone in this room is not part of Kari AS or Acme AS, so it cannot be added.",
        );
        expect(refused).not.toHaveTextContent("Eve");
        expect(within(refused).getByText("Unnamed room")).toBeInTheDocument();
        expect(refused.querySelector("img")).toBeNull();
        expect(refused.querySelector(".mx_BaseAvatar")).toHaveTextContent("U");
        expect(addButton(room.roomId)).toHaveAttribute("aria-disabled", "true");
        // Nor does the search find it by them.
        search("eve");
        expect(screen.queryByTestId(`verji-room-candidate-${room.roomId}`)).not.toBeInTheDocument();
    });

    it("keeps every other room disabled while an assignment runs", async () => {
        const pending = deferred<void>();
        mocked(assignRoomToOrgUnit).mockReturnValue(pending.promise);
        renderDialog();
        await userEvent.click(await screen.findByRole("button", { name: "Show all rooms" }));
        expect(addButton(INTERNAL.roomId)).not.toHaveAttribute("aria-disabled", "true");

        fireEvent.click(addButton(SUGGESTED.roomId));

        expect(addButton(INTERNAL.roomId)).toHaveAttribute("aria-disabled", "true");
        fireEvent.click(addButton(INTERNAL.roomId));
        expect(assignRoomToOrgUnit).toHaveBeenCalledTimes(1);

        await act(async () => {
            pending.resolve();
            await pending.promise;
        });
        expect(addButton(INTERNAL.roomId)).not.toHaveAttribute("aria-disabled", "true");
    });

    describe("when the Organization API refuses the user (403)", () => {
        it("says they can no longer do this here, without a Retry, when it refuses the list", async () => {
            mocked(getOrgUnitRoomCandidates).mockRejectedValue(forbidden());
            renderDialog();

            expect(await screen.findByText("You can no longer do this here.")).toBeInTheDocument();
            expect(screen.queryByText("Could not load the list. Try again.")).not.toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
        });

        it("says the same, without a Retry, when it refuses an assignment: the refusal is of the user, not the room", async () => {
            mocked(assignRoomToOrgUnit).mockRejectedValue(forbidden());
            renderDialog();
            await screen.findByTestId("verji-room-candidates-suggested");

            await clickAdd(SUGGESTED.roomId);

            expect(screen.getByText("You can no longer do this here.")).toBeInTheDocument();
            expect(screen.queryByText("The room could not be added. Try again.")).not.toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
            expect(assignRoomToOrgUnit).toHaveBeenCalledTimes(1);
            // Nothing runs any more: Done closes it.
            expect(screen.getByRole("button", { name: "Done" })).not.toHaveAttribute("aria-disabled", "true");
        });
    });

    describe("the guest org's name", () => {
        const renderWithoutName = () =>
            render(
                <AddExistingRoomToOrgUnitDialog
                    client={client}
                    tenantId="tenant-1"
                    tenantName="Acme AS"
                    orgUnitId="org-a"
                    onFinished={onFinished}
                />,
            );

        it("is its own, as the Organization API lists it, when the opener does not have it", async () => {
            const name = deferred<string | undefined>();
            mocked(getOrgUnitName).mockReturnValue(name.promise);
            renderWithoutName();

            // No name but the guest org's own: until it is known, the title names none.
            expect(screen.getByText("Add existing room")).toBeInTheDocument();
            await act(async () => {
                name.resolve("Kari AS");
                await name.promise;
            });

            expect(getOrgUnitName).toHaveBeenCalledWith(client, "tenant-1", "org-a");
            expect(screen.getByText("Add existing room to Kari AS")).toBeInTheDocument();
            expect(screen.getByText(/Suggested rooms have people from Kari AS in them/)).toBeInTheDocument();
        });

        it("is not asked for when the opener has it", async () => {
            renderDialog();
            await screen.findByTestId("verji-room-candidates-suggested");

            expect(getOrgUnitName).not.toHaveBeenCalled();
            expect(screen.getByText("Add existing room to Kari AS")).toBeInTheDocument();
        });

        it.each([
            ["the Organization API does not list it", () => mocked(getOrgUnitName).mockResolvedValue(undefined)],
            ["it cannot be read", () => mocked(getOrgUnitName).mockRejectedValue(new Error("down"))],
        ])("is 'this guest organization' when %s", async (_when, answer) => {
            answer();
            renderWithoutName();
            await screen.findByTestId("verji-room-candidates-suggested");

            expect(screen.getByText("Add existing room")).toBeInTheDocument();
            expect(
                screen.getByText(/Suggested rooms have people from this guest organization in them/),
            ).toBeInTheDocument();
        });

        describe("when opened on a guest org's space", () => {
            /** A space named otherwise than its guest org, whose Verji events `sender` sent. */
            const orgUnitSpace = (sender: string): Room => {
                const roomId = "!kari:server";
                const state = [
                    mkEvent({
                        event: true,
                        type: "app.verji.tenant_info",
                        skey: "app.verji.tenant_info",
                        room: roomId,
                        user: sender,
                        content: { tenant_id: "tenant-1" },
                    }),
                    mkEvent({
                        event: true,
                        type: "app.verji.org_unit_info",
                        skey: "app.verji.org_unit_info",
                        room: roomId,
                        user: sender,
                        content: { org_unit_id: "org-a" },
                    }),
                ];
                return {
                    roomId,
                    name: "Not what it is called",
                    client,
                    isSpaceRoom: () => true,
                    currentState: { getStateEvents: jest.fn().mockImplementation(mockStateEventImplementation(state)) },
                } as unknown as Room;
            };
            let createDialog: jest.SpyInstance;

            beforeEach(() => {
                mocked(client.getDomain).mockReturnValue("server");
                createDialog = jest.spyOn(Modal, "createDialog").mockReturnValue({} as never);
            });

            afterEach(() => createDialog.mockRestore());

            it("never takes the space's name for the guest org's", () => {
                showAddExistingRoomToOrgUnitDialog(orgUnitSpace("@vsys:server"));
                expect(createDialog).toHaveBeenCalledWith(
                    AddExistingRoomToOrgUnitDialog,
                    expect.objectContaining({ tenantId: "tenant-1", orgUnitId: "org-a", orgUnitName: undefined }),
                    "mx_AddExistingToSpaceDialog_wrapper",
                );

                showAddExistingRoomToOrgUnitDialog(orgUnitSpace("@vsys:server"), "Kari AS");
                expect(createDialog).toHaveBeenLastCalledWith(
                    AddExistingRoomToOrgUnitDialog,
                    expect.objectContaining({ orgUnitName: "Kari AS" }),
                    "mx_AddExistingToSpaceDialog_wrapper",
                );
            });

            it("opens only on a space whose Verji events vsys sent", () => {
                showAddExistingRoomToOrgUnitDialog(orgUnitSpace("@mallory:server"));
                expect(createDialog).not.toHaveBeenCalled();
            });
        });
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

    it("does not offer a room whose fit the client does not know, even behind 'Show all rooms'", async () => {
        const unknown = { ...candidate("!unknown:server", "Future room", "Internal"), fit: "Future" };
        mocked(getOrgUnitRoomCandidates).mockResolvedValue([SUGGESTED, INTERNAL, unknown as OrgUnitRoomCandidate]);
        renderDialog();

        await userEvent.click(await screen.findByRole("button", { name: "Show all rooms" }));

        expect(screen.getByText("Board")).toBeInTheDocument();
        expect(screen.queryByText("Future room")).not.toBeInTheDocument();
    });

    it("filters the rooms on the name each row shows, a room with no name too", async () => {
        const nameless = candidate("!nameless:server", null, "Suggested");
        const namelessRefused = candidate("!nameless-refused:server", null, "Refused", "MemberOutsideOrgUnit");
        mocked(getOrgUnitRoomCandidates).mockResolvedValue([SUGGESTED, nameless, INTERNAL, REFUSED, namelessRefused]);
        renderDialog();
        await screen.findByTestId("verji-room-candidates-suggested");

        search("proj");

        expect(screen.getByText("Project Kari")).toBeInTheDocument();
        expect(screen.queryByText("!nameless:server")).not.toBeInTheDocument();
        expect(screen.queryByText("Mixed room")).not.toBeInTheDocument();
        expect(screen.queryByText("Unnamed room")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Show all rooms" })).not.toBeInTheDocument();

        // A suggested room with no name, and no room in the client, shows and matches its id; a
        // refused one shows and matches "Unnamed room".
        search("unnamed");
        await waitFor(() => expect(screen.queryByText("Project Kari")).not.toBeInTheDocument());
        expect(within(row(namelessRefused.roomId)).getByText("Unnamed room")).toBeInTheDocument();

        search("nameless:server");
        await waitFor(() => expect(screen.getByText("!nameless:server")).toBeInTheDocument());
        expect(screen.queryByText("Unnamed room")).not.toBeInTheDocument();
    });

    it("never shows a refused room under a name or avatar taken from its members", async () => {
        const eve = "@eve:outside.example";
        const me = client.getSafeUserId();
        const room = new Room("!mixed:server", client, me);
        room.currentState.setStateEvents([
            mkMembership({ event: true, room: room.roomId, mship: KnownMembership.Join, user: me, skey: me }),
            mkMembership({
                event: true,
                room: room.roomId,
                mship: KnownMembership.Join,
                user: eve,
                skey: eve,
                name: "Eve Outsider",
                url: "mxc://outside.example/eve",
            }),
        ]);
        room.recalculate();
        expect(room.name).toContain("Eve Outsider");
        mocked(client.getRoom).mockImplementation((id) => (id === room.roomId ? room : null));
        mocked(getOrgUnitRoomCandidates).mockResolvedValue([
            candidate(room.roomId, null, "Refused", "MemberOutsideOrgUnit"),
        ]);
        renderDialog();

        await screen.findByTestId("verji-room-candidates-refused");

        const refused = row(room.roomId);
        expect(refused).not.toHaveTextContent("Eve");
        expect(within(refused).getByText("Unnamed room")).toBeInTheDocument();
        expect(refused.querySelector("img")).toBeNull();
        expect(refused.querySelector(".mx_BaseAvatar")).toHaveTextContent("U");
    });

    it.each([null, "SomethingNew"])(
        "explains a refused room whose reason is %s by its fit, not as a failure",
        async (reason) => {
            mocked(getOrgUnitRoomCandidates).mockResolvedValue([
                { ...REFUSED, reason: reason as OrgUnitRoomCandidate["reason"] },
            ]);
            renderDialog();

            await screen.findByTestId("verji-room-candidates-refused");
            expect(row(REFUSED.roomId)).toHaveTextContent(
                "Someone in this room is not part of Kari AS or Acme AS, so it cannot be added.",
            );
            expect(row(REFUSED.roomId)).not.toHaveTextContent("Try again");
            expect(addButton(REFUSED.roomId)).toHaveAttribute("aria-disabled", "true");
        },
    );

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

    it("sends one assignment for a double click, and keeps Done disabled until it is answered", async () => {
        const pending = deferred<void>();
        mocked(assignRoomToOrgUnit).mockReturnValue(pending.promise);
        renderDialog();
        await screen.findByTestId("verji-room-candidates-suggested");

        const button = addButton(SUGGESTED.roomId);
        fireEvent.click(button);
        fireEvent.click(button);
        fireEvent.keyDown(button, { key: "Enter" });

        expect(assignRoomToOrgUnit).toHaveBeenCalledTimes(1);
        const done = screen.getByRole("button", { name: "Done" });
        expect(done).toHaveAttribute("aria-disabled", "true");
        fireEvent.click(done);
        expect(onFinished).not.toHaveBeenCalled();

        await act(async () => {
            pending.resolve();
            await pending.promise;
        });
        expect(done).not.toHaveAttribute("aria-disabled", "true");
    });

    it.each([
        ["MemberOutsideOrgUnit", "Someone in this room is not part of Kari AS or Acme AS, so it cannot be added."],
        ["AlreadyInOrgUnit", "This room is already in a guest organization."],
        ["CallerNotInRoom", "You are no longer in this room."],
        ["NotInTenant", "This room does not belong to Acme AS."],
        ["NotARoom", "Only rooms can be added, not spaces or direct messages."],
        ["NotPrivate", "Only private rooms can be added to a guest organization."],
    ])("shows a 409 with reason %s as a readable message on the room, and disables it", async (reason, message) => {
        mocked(assignRoomToOrgUnit).mockRejectedValue(new OrgUnitRoomConflictError(reason));
        renderDialog();

        await screen.findByTestId("verji-room-candidates-suggested");
        await clickAdd(SUGGESTED.roomId);

        expect(await within(row(SUGGESTED.roomId)).findByText(message)).toBeInTheDocument();
        expect(addButton(SUGGESTED.roomId)).toHaveTextContent("Add");
        expect(addButton(SUGGESTED.roomId)).toHaveAttribute("aria-disabled", "true");
    });

    it.each([
        ["RoomUnreadable", "This room could not be read. Try again later."],
        ["OrgUnitHasNoSpace", "Kari AS does not have its space yet. Try again in a moment."],
        ["SpaceTenantNotFound", "The room could not be added. Try again."],
        [undefined, "The room could not be added. Try again."],
    ])("shows a 409 with reason %s on the room, and lets it be tried again", async (reason, message) => {
        mocked(assignRoomToOrgUnit).mockRejectedValueOnce(new OrgUnitRoomConflictError(reason));
        renderDialog();

        await screen.findByTestId("verji-room-candidates-suggested");
        await clickAdd(SUGGESTED.roomId);

        expect(within(row(SUGGESTED.roomId)).getByText(message)).toBeInTheDocument();
        expect(addButton(SUGGESTED.roomId)).not.toHaveAttribute("aria-disabled", "true");

        await clickAdd(SUGGESTED.roomId);

        expect(assignRoomToOrgUnit).toHaveBeenCalledTimes(2);
        expect(addButton(SUGGESTED.roomId)).toHaveTextContent("Added");
        expect(row(SUGGESTED.roomId)).not.toHaveTextContent(message);
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

    it.each([
        ["a 409 with a reason the client does not know", () => new OrgUnitRoomConflictError("SomethingNew")],
        ["a 409 with no reason", () => new OrgUnitRoomConflictError(undefined)],
        ["any other failure", () => new Error("down")],
    ])("says the list could not be loaded for %s, and retries", async (_what, failure) => {
        mocked(getOrgUnitRoomCandidates).mockRejectedValueOnce(failure());
        renderDialog();

        expect(await screen.findByText("Could not load the list. Try again.")).toBeInTheDocument();
        expect(screen.queryByText("The room could not be added. Try again.")).not.toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(await screen.findByTestId("verji-room-candidates-suggested")).toBeInTheDocument();
    });

    it("says so when none of the caller's rooms can be added", async () => {
        mocked(getOrgUnitRoomCandidates).mockResolvedValue([]);
        renderDialog();

        expect(await screen.findByText("None of your rooms can be added to Kari AS.")).toBeInTheDocument();
    });

    it("says 'No results' only for a search, not for rooms behind 'Show all rooms'", async () => {
        mocked(getOrgUnitRoomCandidates).mockResolvedValue([INTERNAL]);
        renderDialog();

        expect(await screen.findByRole("button", { name: "Show all rooms" })).toBeInTheDocument();
        expect(screen.queryByText("No results")).not.toBeInTheDocument();
        expect(screen.queryByText("None of your rooms can be added to Kari AS.")).not.toBeInTheDocument();

        search("nothing like it");

        expect(screen.getByText("No results")).toBeInTheDocument();
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
            ["the list arrives", (list: Deferred<OrgUnitRoomCandidate[]>) => list.resolve([SUGGESTED])],
            ["the list fails", (list: Deferred<OrgUnitRoomCandidate[]>) => list.reject(new Error("down"))],
        ])("changes nothing when %s", async (_what, settle) => {
            const list = deferred<OrgUnitRoomCandidate[]>();
            mocked(getOrgUnitRoomCandidates).mockReturnValue(list.promise);
            const { unmount } = renderDialog();

            unmount();
            await act(async () => {
                settle(list);
                await list.promise.catch(() => undefined);
            });

            expect(updatesAfterUnmount()).toEqual([]);
        });

        it.each([
            ["the room is added", (answer: Deferred<void>) => answer.resolve()],
            ["the assignment fails", (answer: Deferred<void>) => answer.reject(new Error("down"))],
            [
                "the room is refused",
                (answer: Deferred<void>) => answer.reject(new OrgUnitRoomConflictError("MemberOutsideOrgUnit")),
            ],
        ])("changes nothing when %s", async (_what, settle) => {
            const answer = deferred<void>();
            mocked(assignRoomToOrgUnit).mockReturnValue(answer.promise);
            const { unmount } = renderDialog();
            await screen.findByTestId("verji-room-candidates-suggested");

            fireEvent.click(addButton(SUGGESTED.roomId));
            unmount();
            await act(async () => {
                settle(answer);
                await answer.promise.catch(() => undefined);
            });

            expect(updatesAfterUnmount()).toEqual([]);
        });
    });

    // From the adversarial review, round 2: each test below fails on the mutant named.
    describe("adversarial review", () => {
        // Kills: the search also matching the member-made name of a room LISTED as Refused.
        it("the search never finds a room listed refused by a member's name", async () => {
            const room = roomWithOutsider();
            mocked(getOrgUnitRoomCandidates).mockResolvedValue([
                candidate(room.roomId, null, "Refused", "MemberOutsideOrgUnit"),
            ]);
            renderDialog();
            await screen.findByTestId("verji-room-candidates-refused");

            search("eve");

            expect(screen.queryByTestId(`verji-room-candidate-${room.roomId}`)).not.toBeInTheDocument();
        });

        // Kills: a 403 on one assignment disabling only that room's row. The Organization API answers
        // an assignment 403 only to a caller who may not assign rooms to the org unit at all.
        it("a 403 on one room's assignment leaves no room to choose", async () => {
            mocked(assignRoomToOrgUnit).mockRejectedValueOnce(forbidden());
            renderDialog();
            await userEvent.click(await screen.findByRole("button", { name: "Show all rooms" }));

            await clickAdd(SUGGESTED.roomId);

            expect(screen.getByText("You can no longer do this here.")).toBeInTheDocument();
            expect(screen.queryAllByTestId(/^verji-room-candidate-/)).toEqual([]);
            expect(screen.queryAllByRole("button", { name: "Add" })).toEqual([]);
        });

        // Kills: a refusal said only on its row, which a search by a member's name then no longer finds.
        it("says a refusal outside the list too, under the row's new name, when the search no longer finds the row", async () => {
            const room = roomWithOutsider();
            mocked(getOrgUnitRoomCandidates).mockResolvedValue([candidate(room.roomId, null, "Suggested")]);
            mocked(assignRoomToOrgUnit).mockRejectedValue(new OrgUnitRoomConflictError("MemberOutsideOrgUnit"));
            renderDialog();
            await screen.findByTestId("verji-room-candidates-suggested");
            // A row that fits shows the client's name for the room, here made up from its members: the search finds it by Eve.
            search("eve");

            await clickAdd(room.roomId);

            // Refused, the row takes nothing from the room's members, so the search finds it no more.
            expect(screen.queryByTestId(`verji-room-candidate-${room.roomId}`)).not.toBeInTheDocument();
            const status = screen.getByRole("status");
            expect(status).toHaveTextContent(
                "Unnamed room was not added. Someone in this room is not part of Kari AS or Acme AS, so it cannot be added.",
            );
            expect(status).not.toHaveTextContent("Eve");
        });

        // Kills: dropping `mounted.current` from the getOrgUnitName effect.
        it("sets no state when the guest org's name arrives after the dialog closed", async () => {
            const errors = jest.spyOn(console, "error");
            const name = deferred<string | undefined>();
            mocked(getOrgUnitName).mockReturnValue(name.promise);
            const { unmount } = render(
                <AddExistingRoomToOrgUnitDialog
                    client={client}
                    tenantId="tenant-1"
                    tenantName="Acme AS"
                    orgUnitId="org-a"
                    onFinished={onFinished}
                />,
            );

            unmount();
            await act(async () => {
                name.resolve("Kari AS");
                await name.promise;
            });

            expect(errors.mock.calls.filter((call) => String(call[0]).includes("unmounted component"))).toEqual([]);
            errors.mockRestore();
        });
    });
});
