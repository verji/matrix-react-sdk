/*
Copyright 2023 Mikhail Aheichyk
Copyright 2023 Nordeck IT + Consulting GmbH.

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

import React, { ComponentProps } from "react";
import { act, cleanup, queryByRole, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mocked } from "jest-mock";
import { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk/src/matrix"; // VERJI: MatrixClient for verji/verji-src#1507
// VERJI START: verji/verji-src#1507 drives a real SDK access-context cache behind the real store.
import { getVerjiApiSdk, initVerjiApiSdkAsync } from "@verji/verji-api-sdk/lib/asyncInit";
import { createPermissionStore, PermissionPersistence } from "@verji/verji-api-sdk/lib/permissions";
// VERJI END

// VERJI START: types for the same, verji/verji-src#1507.
import type { PermissionStore } from "@verji/verji-api-sdk";
import type { AcContextResponse } from "@verji/verji-api-sdk/lib/services/itopsService/types";
// VERJI END
import RoomList from "../../../../src/components/views/rooms/RoomList";
import ResizeNotifier from "../../../../src/utils/ResizeNotifier";
import { MetaSpace } from "../../../../src/stores/spaces";
import { shouldShowComponent } from "../../../../src/customisations/helpers/UIComponents";
import { UIComponent, UIFeature } from "../../../../src/settings/UIFeature";
import dis from "../../../../src/dispatcher/dispatcher";
import { Action } from "../../../../src/dispatcher/actions";
import * as testUtils from "../../../test-utils";
import { mkEvent, mkSpace, mockStateEventImplementation, stubClient } from "../../../test-utils";
import { MatrixClientPeg } from "../../../../src/MatrixClientPeg";
import SpaceStore from "../../../../src/stores/spaces/SpaceStore";
import DMRoomMap from "../../../../src/utils/DMRoomMap";
import RoomListStore from "../../../../src/stores/room-list/RoomListStore";
import { ITagMap } from "../../../../src/stores/room-list/algorithms/models";
import { DefaultTagID } from "../../../../src/stores/room-list/models";
import SettingsStore from "../../../../src/settings/SettingsStore";
import { VerjiPermissionsStore } from "../../../../src/stores/verji/VerjiPermissionsStore";
import * as verjiGates from "../../../../src/stores/verji/verjiGates";
import SdkConfig from "../../../../src/SdkConfig"; // VERJI: verji/verji-src#1507 configures itops for one block

jest.mock("../../../../src/customisations/helpers/UIComponents", () => ({
    shouldShowComponent: jest.fn(),
}));

// VERJI: verji/verji-src#1507 hands the store a real SDK cache without initialising the whole SDK.
// Nothing else in this file reaches the store's init: itops is not configured outside that block.
jest.mock("@verji/verji-api-sdk/lib/asyncInit", () => ({
    initVerjiApiSdkAsync: jest.fn(),
    getVerjiApiSdk: jest.fn(),
}));

jest.mock("../../../../src/dispatcher/dispatcher");

const getUserIdForRoomId = jest.fn();
const getDMRoomsForUserId = jest.fn();
// @ts-ignore
DMRoomMap.sharedInstance = { getUserIdForRoomId, getDMRoomsForUserId };

describe("UIFeature tests", () => {
    stubClient();
    const store = SpaceStore.instance;

    function getComponent(props: Partial<ComponentProps<typeof RoomList>> = {}): JSX.Element {
        return (
            <RoomList
                onKeyDown={jest.fn()}
                onFocus={jest.fn()}
                onBlur={jest.fn()}
                onResize={jest.fn()}
                resizeNotifier={new ResizeNotifier()}
                isMinimized={false}
                activeSpace={MetaSpace.Home}
                {...props}
            />
        );
    }
    beforeEach(() => {
        store.setActiveSpace(MetaSpace.Home);
        mocked(shouldShowComponent).mockImplementation((feature) => true);
    });
    describe("UIFeature.showStartChatPlusMenuForMetaSpace", () => {
        it("UIFeature.showStartChatPlusMenuForMetaSpace = true: renders 'Start Chat' plus-button", () => {
            jest.spyOn(SettingsStore, "getValue").mockImplementation((name: string) => {
                if (name == UIFeature.ShowStartChatPlusMenuForMetaSpace) return true;
                return false;
            });
            render(getComponent());

            expect(screen.getByLabelText("Start chat")).toBeInTheDocument();
        });

        it("UIFeature.showStartChatPlusMenuForMetaSpace = false: does not render 'Start Chat' plus-button", () => {
            jest.spyOn(SettingsStore, "getValue").mockImplementation((name: string) => {
                if (name == UIFeature.ShowStartChatPlusMenuForMetaSpace) return false;
                return false;
            });
            render(getComponent());
            expect(screen.queryByLabelText("Start chat")).not.toBeInTheDocument();
        });
    });

    describe("UIFeature.showAddRoomPlusMenuForMetaSpace", () => {
        beforeEach(() => {
            store.setActiveSpace(MetaSpace.Home);
        });

        it("UIFeature.showAddRoomPlusMenuForMetaSpace = true: renders 'Add room' plus-button", () => {
            jest.spyOn(SettingsStore, "getValue").mockImplementation((name: string) => {
                if (name == UIFeature.ShowAddRoomPlusMenuForMetaSpace) return true;
                return false;
            });
            render(getComponent());
            expect(screen.getByLabelText("Add room")).toBeInTheDocument();
        });

        it("UIFeature.showAddRoomPlusMenuForMetaSpace = false: does not render 'Add room' plus-button", () => {
            jest.spyOn(SettingsStore, "getValue").mockImplementation((name: string) => {
                if (name == UIFeature.ShowAddRoomPlusMenuForMetaSpace) return false;
                return false;
            });

            render(getComponent());

            expect(screen.queryByLabelText("Add room")).not.toBeInTheDocument();
        });
    });
    afterEach(() => {
        jest.spyOn(SettingsStore, "getValue").mockImplementation((name: string) => true);
    });
});

describe("RoomList", () => {
    stubClient();
    const client = MatrixClientPeg.safeGet();
    const store = SpaceStore.instance;

    function getComponent(props: Partial<ComponentProps<typeof RoomList>> = {}): JSX.Element {
        return (
            <RoomList
                onKeyDown={jest.fn()}
                onFocus={jest.fn()}
                onBlur={jest.fn()}
                onResize={jest.fn()}
                resizeNotifier={new ResizeNotifier()}
                isMinimized={false}
                activeSpace={MetaSpace.Home}
                {...props}
            />
        );
    }

    describe("Rooms", () => {
        describe("when meta space is active", () => {
            beforeEach(() => {
                store.setActiveSpace(MetaSpace.Home);
            });

            it("does not render add room button when UIComponent customisation disables CreateRooms and ExploreRooms", () => {
                const disabled: UIComponent[] = [UIComponent.CreateRooms, UIComponent.ExploreRooms];
                mocked(shouldShowComponent).mockImplementation((feature) => !disabled.includes(feature));
                render(getComponent());

                const roomsList = screen.getByRole("group", { name: "Rooms" });
                expect(within(roomsList).queryByRole("button", { name: "Add room" })).not.toBeInTheDocument();
            });

            it("renders add room button with menu when UIComponent customisation allows CreateRooms or ExploreRooms", async () => {
                let disabled: UIComponent[] = [];
                mocked(shouldShowComponent).mockImplementation((feature) => !disabled.includes(feature));
                const { rerender } = render(getComponent());

                const roomsList = screen.getByRole("group", { name: "Rooms" });
                const addRoomButton = within(roomsList).getByRole("button", { name: "Add room" });
                expect(screen.queryByRole("menu")).not.toBeInTheDocument();

                await userEvent.click(addRoomButton);

                const menu = screen.getByRole("menu");

                expect(within(menu).getByRole("menuitem", { name: "New room" })).toBeInTheDocument();
                expect(within(menu).getByRole("menuitem", { name: "Explore public rooms" })).toBeInTheDocument();

                disabled = [UIComponent.CreateRooms];
                rerender(getComponent());

                expect(addRoomButton).toBeInTheDocument();
                expect(menu).toBeInTheDocument();
                expect(within(menu).queryByRole("menuitem", { name: "New room" })).not.toBeInTheDocument();
                expect(within(menu).getByRole("menuitem", { name: "Explore public rooms" })).toBeInTheDocument();

                disabled = [UIComponent.ExploreRooms];
                rerender(getComponent());

                expect(addRoomButton).toBeInTheDocument();
                expect(menu).toBeInTheDocument();
                expect(within(menu).getByRole("menuitem", { name: "New room" })).toBeInTheDocument();
                expect(within(menu).queryByRole("menuitem", { name: "Explore public rooms" })).not.toBeInTheDocument();
            });

            it("renders add room button and clicks explore public rooms", async () => {
                mocked(shouldShowComponent).mockReturnValue(true);
                render(getComponent());

                const roomsList = screen.getByRole("group", { name: "Rooms" });
                await userEvent.click(within(roomsList).getByRole("button", { name: "Add room" }));

                const menu = screen.getByRole("menu");
                await userEvent.click(within(menu).getByRole("menuitem", { name: "Explore public rooms" }));

                expect(dis.fire).toHaveBeenCalledWith(Action.ViewRoomDirectory);
            });
        });

        describe("when room space is active", () => {
            let rooms: Room[];
            const mkSpaceForRooms = (spaceId: string, children: string[] = []) =>
                mkSpace(client, spaceId, rooms, children);

            const space1 = "!space1:server";

            beforeEach(async () => {
                rooms = [];
                mkSpaceForRooms(space1);
                mocked(client).getRoom.mockImplementation(
                    (roomId) => rooms.find((room) => room.roomId === roomId) || null,
                );
                await testUtils.setupAsyncStoreWithClient(store, client);

                store.setActiveSpace(space1);
            });

            it("does not render add room button when UIComponent customisation disables CreateRooms and ExploreRooms", () => {
                const disabled: UIComponent[] = [UIComponent.CreateRooms, UIComponent.ExploreRooms];
                mocked(shouldShowComponent).mockImplementation((feature) => !disabled.includes(feature));
                render(getComponent());

                const roomsList = screen.getByRole("group", { name: "Rooms" });
                expect(within(roomsList).queryByRole("button", { name: "Add room" })).not.toBeInTheDocument();
            });

            it("renders add room button with menu when UIComponent customisation allows CreateRooms or ExploreRooms", async () => {
                let disabled: UIComponent[] = [];
                mocked(shouldShowComponent).mockImplementation((feature) => !disabled.includes(feature));
                const { rerender } = render(getComponent());

                const roomsList = screen.getByRole("group", { name: "Rooms" });
                const addRoomButton = within(roomsList).getByRole("button", { name: "Add room" });
                expect(screen.queryByRole("menu")).not.toBeInTheDocument();

                await userEvent.click(addRoomButton);

                const menu = screen.getByRole("menu");

                expect(within(menu).getByRole("menuitem", { name: "Explore rooms" })).toBeInTheDocument();
                expect(within(menu).getByRole("menuitem", { name: "New room" })).toBeInTheDocument();
                expect(within(menu).getByRole("menuitem", { name: "Add existing room" })).toBeInTheDocument();

                disabled = [UIComponent.CreateRooms];
                rerender(getComponent());

                expect(addRoomButton).toBeInTheDocument();
                expect(menu).toBeInTheDocument();
                expect(within(menu).getByRole("menuitem", { name: "Explore rooms" })).toBeInTheDocument();
                expect(within(menu).queryByRole("menuitem", { name: "New room" })).not.toBeInTheDocument();
                expect(within(menu).queryByRole("menuitem", { name: "Add existing room" })).not.toBeInTheDocument();

                disabled = [UIComponent.ExploreRooms];
                rerender(getComponent());

                expect(addRoomButton).toBeInTheDocument();
                expect(menu).toBeInTheDocument();
                expect(within(menu).queryByRole("menuitem", { name: "Explore rooms" })).toBeInTheDocument();
                expect(within(menu).getByRole("menuitem", { name: "New room" })).toBeInTheDocument();
                expect(within(menu).getByRole("menuitem", { name: "Add existing room" })).toBeInTheDocument();
            });

            it("renders add room button and clicks explore rooms", async () => {
                mocked(shouldShowComponent).mockReturnValue(true);
                render(getComponent());

                const roomsList = screen.getByRole("group", { name: "Rooms" });
                await userEvent.click(within(roomsList).getByRole("button", { name: "Add room" }));

                const menu = screen.getByRole("menu");
                await userEvent.click(within(menu).getByRole("menuitem", { name: "Explore rooms" }));

                expect(dis.dispatch).toHaveBeenCalledWith({
                    action: Action.ViewRoom,
                    room_id: space1,
                });
            });

            it("UIFeature.addExistingRoomToSpace = true: should render 'Add existing room' context menu option", async () => {
                jest.spyOn(SettingsStore, "getValue").mockImplementation((val) =>
                    val === UIFeature.AddExistingRoomToSpace ? true : "default",
                );
                mocked(shouldShowComponent).mockReturnValue(true);
                render(getComponent());

                const roomsList = screen.getByRole("group", { name: "Rooms" });
                await userEvent.click(within(roomsList).getByRole("button", { name: "Add room" }));

                const menu = screen.getByRole("menu");
                expect(within(menu).getByRole("menuitem", { name: "Add existing room" })).toBeInTheDocument();
            });

            it("UIFeature.addExistingRoomToSpace = false: should not render 'Add existing room' context menu option", async () => {
                jest.spyOn(SettingsStore, "getValue").mockImplementation((val) =>
                    val === UIFeature.AddExistingRoomToSpace ? false : "default",
                );
                mocked(shouldShowComponent).mockReturnValue(true);
                render(getComponent());

                const roomsList = screen.getByRole("group", { name: "Rooms" });
                await userEvent.click(within(roomsList).getByRole("button", { name: "Add room" }));

                const menu = screen.getByRole("menu");
                expect(within(menu).queryByRole("menuitem", { name: "Add existing room" })).not.toBeInTheDocument();
            });
        });

        describe("when video meta space is active", () => {
            const videoRoomPrivate = "!videoRoomPrivate_server";
            const videoRoomPublic = "!videoRoomPublic_server";
            const videoRoomKnock = "!videoRoomKnock_server";

            beforeEach(async () => {
                cleanup();
                const rooms: Room[] = [];
                RoomListStore.instance;
                testUtils.mkRoom(client, videoRoomPrivate, rooms);
                testUtils.mkRoom(client, videoRoomPublic, rooms);
                testUtils.mkRoom(client, videoRoomKnock, rooms);

                mocked(client).getRoom.mockImplementation(
                    (roomId) => rooms.find((room) => room.roomId === roomId) || null,
                );
                mocked(client).getRooms.mockImplementation(() => rooms);

                const videoRoomKnockRoom = client.getRoom(videoRoomKnock)!;
                const videoRoomPrivateRoom = client.getRoom(videoRoomPrivate)!;
                const videoRoomPublicRoom = client.getRoom(videoRoomPublic)!;

                [videoRoomPrivateRoom, videoRoomPublicRoom, videoRoomKnockRoom].forEach((room) => {
                    (room.isCallRoom as jest.Mock).mockReturnValue(true);
                });

                const roomLists: ITagMap = {};
                roomLists[DefaultTagID.Conference] = [videoRoomKnockRoom, videoRoomPublicRoom];
                roomLists[DefaultTagID.Untagged] = [videoRoomPrivateRoom];
                jest.spyOn(RoomListStore.instance, "orderedLists", "get").mockReturnValue(roomLists);
                await testUtils.setupAsyncStoreWithClient(store, client);

                store.setActiveSpace(MetaSpace.VideoRooms);
            });

            it("renders Conferences and Room but no People section", () => {
                const renderResult = render(getComponent({ activeSpace: MetaSpace.VideoRooms }));
                const roomsEl = renderResult.getByRole("treeitem", { name: "Rooms" });
                const conferenceEl = renderResult.getByRole("treeitem", { name: "Conferences" });

                const noInvites = screen.queryByRole("treeitem", { name: "Invites" });
                const noFavourites = screen.queryByRole("treeitem", { name: "Favourites" });
                const noPeople = screen.queryByRole("treeitem", { name: "People" });
                const noLowPriority = screen.queryByRole("treeitem", { name: "Low priority" });
                const noHistorical = screen.queryByRole("treeitem", { name: "Historical" });

                expect(roomsEl).toBeVisible();
                expect(conferenceEl).toBeVisible();

                expect(noInvites).toBeFalsy();
                expect(noFavourites).toBeFalsy();
                expect(noPeople).toBeFalsy();
                expect(noLowPriority).toBeFalsy();
                expect(noHistorical).toBeFalsy();
            });
            it("renders Public and Knock rooms in Conferences section", () => {
                const renderResult = render(getComponent({ activeSpace: MetaSpace.VideoRooms }));
                const conferenceList = renderResult.getByRole("group", { name: "Conferences" });
                expect(queryByRole(conferenceList, "treeitem", { name: videoRoomPublic })).toBeVisible();
                expect(queryByRole(conferenceList, "treeitem", { name: videoRoomKnock })).toBeVisible();
                expect(queryByRole(conferenceList, "treeitem", { name: videoRoomPrivate })).toBeFalsy();

                const roomsList = renderResult.getByRole("group", { name: "Rooms" });
                expect(queryByRole(roomsList, "treeitem", { name: videoRoomPrivate })).toBeVisible();
                expect(queryByRole(roomsList, "treeitem", { name: videoRoomPublic })).toBeFalsy();
                expect(queryByRole(roomsList, "treeitem", { name: videoRoomKnock })).toBeFalsy();
            });
        });
    });
});

describe("UIFeature tests part 2", () => {
    stubClient();
    const store = SpaceStore.instance;

    function getComponent(props: Partial<ComponentProps<typeof RoomList>> = {}): JSX.Element {
        return (
            <RoomList
                onKeyDown={jest.fn()}
                onFocus={jest.fn()}
                onBlur={jest.fn()}
                onResize={jest.fn()}
                resizeNotifier={new ResizeNotifier()}
                isMinimized={false}
                activeSpace={MetaSpace.Home}
                {...props}
            />
        );
    }
    beforeEach(() => {
        store.setActiveSpace(MetaSpace.Home);
        mocked(shouldShowComponent).mockImplementation((feature) => true);
    });
    describe("UIFeature.showInviteToSpaceFromPeoplePlus", () => {
        stubClient();
        const client = MatrixClientPeg.safeGet();
        const store = SpaceStore.instance;
        let rooms: Room[];
        const mkSpaceForRooms = (spaceId: string, children: string[] = []) => mkSpace(client, spaceId, rooms, children);

        const space1 = "!verjispace1:server";

        beforeEach(async () => {
            rooms = [];
            mkSpaceForRooms(space1);
            mocked(client).getRoom.mockImplementation((roomId) => rooms.find((room) => room.roomId === roomId) || null);
            await testUtils.setupAsyncStoreWithClient(store, client);

            store.setActiveSpace(space1);
        });
        it("UIFeature.showInviteToSpaceFromPeoplePlus = true: renders 'Invite to space'-button", async () => {
            jest.spyOn(SettingsStore, "getValue").mockImplementation((name: string) => {
                if (name == UIFeature.ShowInviteToSpaceFromPeoplePlus) return true;
                return false;
            });
            render(getComponent());
            const peoplePlusButton = screen.getByLabelText("Add people");
            await userEvent.click(peoplePlusButton);

            expect(screen.getByLabelText("Invite to space")).toBeInTheDocument();
        });

        it("UIFeature.showInviteToSpaceFromPeoplePlus = false: does not render 'Invite to space'-button", async () => {
            jest.spyOn(SettingsStore, "getValue").mockImplementation((name: string) => {
                if (name == UIFeature.ShowInviteToSpaceFromPeoplePlus) return false;
                return false;
            });
            render(getComponent());
            const peoplePlusButton = screen.getByLabelText("Add people");
            await userEvent.click(peoplePlusButton);

            expect(screen.queryByLabelText("Invite to space")).not.toBeInTheDocument();
        });
    });
});

// VERJI: Hierarchy V2 per-user gating.
describe("Verji Hierarchy V2 gates", () => {
    stubClient();
    const client = MatrixClientPeg.safeGet();
    const store = SpaceStore.instance;

    const TENANT = "tenant-1";
    const ORG_A = "org-a";
    const spaceId = "!verji-gated-space:server";

    let rooms: Room[];
    /** Accumulated so a second stampSpace call adds to, rather than replaces, the space's state. */
    let spaceState: MatrixEvent[];

    function getComponent(props: Partial<ComponentProps<typeof RoomList>> = {}): JSX.Element {
        return (
            <RoomList
                onKeyDown={jest.fn()}
                onFocus={jest.fn()}
                onBlur={jest.fn()}
                onResize={jest.fn()}
                resizeNotifier={new ResizeNotifier()}
                isMinimized={false}
                activeSpace={MetaSpace.Home}
                {...props}
            />
        );
    }

    /**
     * Put Verji state events on a space, exactly as itops-matrix writes them: the event type is
     * also the state key. mkSpace's room is a mock, so this re-drives its getStateEvents mock
     * rather than calling the real state store.
     */
    const stampSpace = (space: Room, events: Record<string, object>): void => {
        for (const [type, content] of Object.entries(events)) {
            spaceState.push(
                mkEvent({
                    event: true,
                    type,
                    room: space.roomId,
                    user: client.getSafeUserId(),
                    skey: type,
                    content,
                    ts: Date.now(),
                }),
            );
        }
        mocked(space.currentState).getStateEvents.mockImplementation(mockStateEventImplementation(spaceState));
    };

    /**
     * Stand in for the SDK-backed store. Everything the gates read goes through these. Grants are
     * held for TENANT only, so a read keyed by the wrong tenant gets a wrong answer rather than the
     * same one.
     *
     * @param exhausted OrgUnits whose re-fetch the store has used up (verji/verji-src#1507)
     */
    const mockStore = (rolloutOn: boolean, grants: Record<string, string[]> = {}, exhausted: string[] = []): void => {
        jest.spyOn(VerjiPermissionsStore.instance, "isCanonicalSpaceSyncEnabled").mockImplementation(
            (tenantId) => rolloutOn && tenantId === TENANT,
        );
        jest.spyOn(VerjiPermissionsStore.instance, "hasRole").mockImplementation(
            (tenantId, roleName, instanceId) => tenantId === TENANT && (grants[roleName] ?? []).includes(instanceId),
        );
        jest.spyOn(VerjiPermissionsStore.instance, "isInstanceReferenced").mockImplementation(
            (tenantId, instanceId) =>
                tenantId === TENANT && Object.values(grants).some((instances) => instances.includes(instanceId)),
        );
        jest.spyOn(VerjiPermissionsStore.instance, "isOrgUnitRefreshExhausted").mockImplementation(
            (tenantId, orgUnitId) => tenantId === TENANT && exhausted.includes(orgUnitId),
        );
    };

    /**
     * The hint is a hover tooltip, not a DOM title attribute — AccessibleButton renders `title`
     * through compound-web's Tooltip, which mounts its label lazily. Hovering is what a user does
     * to read it, so hovering is what the test does.
     */
    const expectHint = async (button: HTMLElement, expected: string): Promise<void> => {
        await userEvent.hover(button);
        const tooltip = await screen.findByRole("tooltip");
        expect(tooltip.textContent).toContain(expected);
    };

    const STANDARD_USER = { "Customer-User#": [TENANT] };
    /**
     * What the backend writes for a non-member who joined one of ORG_A's rooms: ORG_A is in their
     * context, but not as membership, so a "no" for them is a genuine no.
     */
    const JOINED_A_ROOM_IN_ORG_A = { "ClientOrganization-SmsRoomMember": [ORG_A] };

    beforeEach(async () => {
        rooms = [];
        spaceState = [];
        const space = mkSpace(client, spaceId, rooms, []);
        mocked(client).getRoom.mockImplementation((roomId) => rooms.find((room) => room.roomId === roomId) || null);
        await testUtils.setupAsyncStoreWithClient(store, client);
        store.setActiveSpace(spaceId);

        mocked(shouldShowComponent).mockReturnValue(true);
        jest.spyOn(SettingsStore, "getValue").mockImplementation(() => true);

        stampSpace(space, { "app.verji.tenant_info": { tenant_id: TENANT } });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    /**
     * The hard product requirement: outside the beta, nothing changes. Not "deny", not "checking" —
     * today's behaviour. A gate that regresses this silently restricts production users.
     */
    describe("with canonicalSpaceSyncEnabled false", () => {
        it.each([
            ["a Guest", {}],
            ["a StandardUser", STANDARD_USER],
        ])("renders Persons+ enabled for %s, exactly as today", (_who, grants) => {
            mockStore(false, grants);

            render(getComponent());

            expect(screen.getByLabelText("Add people")).not.toHaveAttribute("aria-disabled", "true");
        });

        it.each([
            ["a Guest", {}],
            ["a StandardUser", STANDARD_USER],
        ])("renders the Rooms + enabled for %s, exactly as today", (_who, grants) => {
            mockStore(false, grants);

            render(getComponent());

            expect(screen.getByLabelText("Add room")).not.toHaveAttribute("aria-disabled", "true");
        });

        it("leaves the Rooms + present at an OrgUnitCategory space", () => {
            // With gating on this kind hides the button entirely, so this is the sharpest proof
            // that the short-circuit runs before the space kind is ever consulted.
            stampSpace(store.activeSpaceRoom!, {
                "app.verji.canonical_parent_space": { canonical_parent_space_id: "!parent:server" },
            });
            mockStore(false, STANDARD_USER);

            render(getComponent());

            expect(screen.getByLabelText("Add room")).toBeInTheDocument();
        });
    });

    /**
     * No mockStore here: this is the store production has before the first access context lands,
     * or when itops is unconfigured or its init threw. Every other test in this block stubs the
     * store's reads, so without these the fail-safe default is proven only for the stub.
     */
    describe("against the real, uninitialised store", () => {
        it("renders both controls enabled at a TenantRoot", () => {
            render(getComponent());

            expect(screen.getByLabelText("Add people")).not.toHaveAttribute("aria-disabled", "true");
            expect(screen.getByLabelText("Add room")).not.toHaveAttribute("aria-disabled", "true");
        });

        it("leaves the Rooms + present at an OrgUnitCategory space", () => {
            stampSpace(store.activeSpaceRoom!, {
                "app.verji.canonical_parent_space": { canonical_parent_space_id: "!parent:server" },
            });

            render(getComponent());

            expect(screen.getByLabelText("Add room")).not.toHaveAttribute("aria-disabled", "true");
        });
    });

    describe("with canonicalSpaceSyncEnabled true, at a TenantRoot space", () => {
        it("renders both controls enabled for a StandardUser", () => {
            mockStore(true, STANDARD_USER);

            render(getComponent());

            expect(screen.getByLabelText("Add people")).not.toHaveAttribute("aria-disabled", "true");
            expect(screen.getByLabelText("Add room")).not.toHaveAttribute("aria-disabled", "true");
        });

        it("renders Persons+ disabled with the hint for a Guest", async () => {
            mockStore(true, {});

            render(getComponent());

            const button = screen.getByLabelText("Add people");
            expect(button).toHaveAttribute("aria-disabled", "true");
            // The invite wording, not the shared "guest account" prefix: the create-room guest hint
            // starts the same way, so only this proves Persons+ reads its own gate.
            await expectHint(button, "so you cannot invite new users");
        });

        it("removes Persons+ when its gate says Hidden", () => {
            // No gate returns Hidden for Persons+ today; this pins that the surface honours the
            // verdict anyway, so a future gate cannot render a hidden affordance enabled.
            jest.spyOn(verjiGates, "getOnboardToTenantGate").mockReturnValue({
                verdict: verjiGates.VerjiGateVerdict.Hidden,
            });
            mockStore(true, STANDARD_USER);

            render(getComponent());

            expect(screen.queryByLabelText("Add people")).not.toBeInTheDocument();
        });

        it("renders the Rooms + disabled with the hint for a Guest", async () => {
            mockStore(true, {});

            render(getComponent());

            const button = screen.getByLabelText("Add room");
            expect(button).toHaveAttribute("aria-disabled", "true");
            await expectHint(button, "cannot create rooms in this space");
        });

        it("does not open the create-room menu when denied", async () => {
            mockStore(true, {});

            render(getComponent());
            await userEvent.click(screen.getByLabelText("Add room"));

            expect(screen.queryByRole("menu")).not.toBeInTheDocument();
        });
    });

    describe("with canonicalSpaceSyncEnabled true, at an OrgUnitCategory space", () => {
        beforeEach(() => {
            stampSpace(store.activeSpaceRoom!, {
                "app.verji.canonical_parent_space": { canonical_parent_space_id: "!parent:server" },
            });
        });

        it.each([
            ["a Guest", {}],
            ["a StandardUser", STANDARD_USER],
            ["the tenant PrimaryContact", { "Customer-User#": [TENANT], "Customer-Manager#": [TENANT] }],
        ])("renders no create-room affordance for %s", (_who, grants) => {
            mockStore(true, grants);

            render(getComponent());

            expect(screen.queryByLabelText("Add room")).not.toBeInTheDocument();
        });

        it("keeps Persons+ enabled for a StandardUser", () => {
            // Onboarding follows the tenant, not depth: the category's kind must not reach it.
            mockStore(true, STANDARD_USER);

            render(getComponent());

            expect(screen.getByLabelText("Add people")).not.toHaveAttribute("aria-disabled", "true");
        });
    });

    describe("with canonicalSpaceSyncEnabled true, at a top-level space carrying a parent pointer", () => {
        // A pre-split tenant-root personal space mirrors its canonical under canonical_parent_space.
        // Only its being a root of the space tree tells it apart from an OrgUnitCategory, and the
        // hook is what supplies that fact.
        beforeEach(() => {
            jest.spyOn(SpaceStore.instance, "spacePanelSpaces", "get").mockReturnValue([store.activeSpaceRoom!]);
            stampSpace(store.activeSpaceRoom!, {
                "app.verji.canonical_parent_space": { canonical_parent_space_id: "!parent:server" },
            });
        });

        it("reads it as a TenantRoot, so the Rooms + stays for a StandardUser", () => {
            mockStore(true, STANDARD_USER);

            render(getComponent());

            expect(screen.getByLabelText("Add room")).not.toHaveAttribute("aria-disabled", "true");
        });

        it("still denies a Guest there, with the guest hint", async () => {
            mockStore(true, {});

            render(getComponent());

            const button = screen.getByLabelText("Add room");
            expect(button).toHaveAttribute("aria-disabled", "true");
            await expectHint(button, "You are a guest in");
        });
    });

    describe("with canonicalSpaceSyncEnabled true, at an OrgUnit space", () => {
        beforeEach(() => {
            stampSpace(store.activeSpaceRoom!, {
                "app.verji.org_unit_info": { org_unit_id: ORG_A },
                "app.verji.canonical_parent_space": { canonical_parent_space_id: "!parent:server" },
            });
        });

        it("enables the Rooms + for a StandardUser who is a Member", () => {
            mockStore(true, { ...STANDARD_USER, "ClientOrganization-User#": [ORG_A] });

            render(getComponent());

            expect(screen.getByLabelText("Add room")).not.toHaveAttribute("aria-disabled", "true");
        });

        it("enables the Rooms + for a StandardUser who is the Owner", () => {
            mockStore(true, { ...STANDARD_USER, "ClientOrganization-Owner": [ORG_A] });

            render(getComponent());

            expect(screen.getByLabelText("Add room")).not.toHaveAttribute("aria-disabled", "true");
        });

        it("disables it for a StandardUser who holds the structure but not membership", async () => {
            mockStore(true, {
                ...STANDARD_USER,
                ...JOINED_A_ROOM_IN_ORG_A,
                "ClientOrganization-User#": ["some-other-org"],
            });

            render(getComponent());

            const button = screen.getByLabelText("Add room");
            expect(button).toHaveAttribute("aria-disabled", "true");
            await expectHint(button, "not a member of this organisation");
        });

        it("keeps Persons+ enabled for that same StandardUser", () => {
            // The two surfaces disagree here, which is what proves each reads its own gate.
            mockStore(true, {
                ...STANDARD_USER,
                ...JOINED_A_ROOM_IN_ORG_A,
                "ClientOrganization-User#": ["some-other-org"],
            });

            render(getComponent());

            expect(screen.getByLabelText("Add people")).not.toHaveAttribute("aria-disabled", "true");
            expect(screen.getByLabelText("Add room")).toHaveAttribute("aria-disabled", "true");
        });

        it("disables Persons+ for a Guest with the invite hint", async () => {
            mockStore(true, { "ClientOrganization-User#": [ORG_A] });

            render(getComponent());

            const button = screen.getByLabelText("Add people");
            expect(button).toHaveAttribute("aria-disabled", "true");
            await expectHint(button, "so you cannot invite new users");
        });

        it("names the tenant's root space in the hint, not the OrgUnit space", async () => {
            // Standing is decided per tenant, so the hint names the tenant even when it is shown
            // on an OrgUnit space.
            const root = mkSpace(client, "!tenant-root:server");
            root.name = "Acme AS";
            mocked(root.currentState).getStateEvents.mockImplementation(
                mockStateEventImplementation([
                    mkEvent({
                        event: true,
                        type: "app.verji.tenant_info",
                        room: root.roomId,
                        user: client.getSafeUserId(),
                        skey: "app.verji.tenant_info",
                        content: { tenant_id: TENANT },
                        ts: Date.now(),
                    }),
                ]),
            );
            jest.spyOn(SpaceStore.instance, "spacePanelSpaces", "get").mockReturnValue([root]);
            store.activeSpaceRoom!.name = "Org A";
            mockStore(true, { "ClientOrganization-User#": [ORG_A] });

            render(getComponent());

            await expectHint(
                screen.getByLabelText("Add people"),
                "You are a guest in Acme AS, so you cannot invite new users to this space.",
            );
        });

        // VERJI: verji/verji-src#1507 — the cached context has never heard of the OrgUnit.
        describe("when the cached context has never heard of the OrgUnit", () => {
            it("renders the Rooms + disabled with the checking hint, and opens no menu", async () => {
                mockStore(true, STANDARD_USER);

                render(getComponent());

                const button = screen.getByLabelText("Add room");
                expect(button).toHaveAttribute("aria-disabled", "true");
                await expectHint(button, "Checking your access");
                await userEvent.click(button);
                expect(screen.queryByRole("menu")).not.toBeInTheDocument();
            });

            it("settles on the not-a-member hint once the store's re-fetch is used up", async () => {
                mockStore(true, STANDARD_USER, [ORG_A]);

                render(getComponent());

                const button = screen.getByLabelText("Add room");
                expect(button).toHaveAttribute("aria-disabled", "true");
                await expectHint(button, "not a member of this organisation");
            });

            it("renders the Rooms + enabled, exactly as today, when the rollout switch is off", () => {
                mockStore(false, STANDARD_USER);

                render(getComponent());

                expect(screen.getByLabelText("Add room")).not.toHaveAttribute("aria-disabled", "true");
            });
        });
    });

    /**
     * verji/verji-src#1507 end to end, with no read stubbed between the button and the network: the
     * real hook and gates read the real bridge store, which reads a real SDK access-context cache,
     * which a fake itops feeds. Every other create-room test here stubs the store's reads, so this
     * is the one that proves the wiring — the re-fetch is requested by the render, and the response
     * re-renders the button.
     */
    describe("against the real store and a real SDK cache, when the guest org is newer than the cache", () => {
        /** What itops would answer now. Changed by a test to play the backend writing a row. */
        let serverRoles: Record<string, string[]>;
        /** While set, itops holds its responses until it settles. */
        let holdResponses: Promise<void> | undefined;
        let contextFetcher: jest.Mock<Promise<AcContextResponse>, [unknown, string]>;
        let sdkPermissions: PermissionStore;

        /** The SDK's IndexedDB persistence, minus IndexedDB: this test is about memory and events. */
        const noPersistence = (): PermissionPersistence => ({
            open: async () => {},
            isEnabled: () => false,
            readOwner: async () => undefined,
            writeOwner: async () => {},
            clearOwner: async () => {},
            loadAll: async () => [],
            put: async () => {},
            deleteRecord: async () => {},
            loadAllContexts: async () => [],
            putContext: async () => {},
            deleteContext: async () => {},
            clearTenant: async () => {},
            clearAllRecords: async () => {},
            close: () => {},
        });

        beforeEach(async () => {
            stampSpace(store.activeSpaceRoom!, {
                "app.verji.org_unit_info": { org_unit_id: ORG_A },
                "app.verji.canonical_parent_space": { canonical_parent_space_id: "!parent:server" },
            });
            serverRoles = { ...STANDARD_USER };
            holdResponses = undefined;
            contextFetcher = jest.fn(async (_token: unknown, tenantId: string): Promise<AcContextResponse> => {
                await holdResponses;
                return {
                    userId: client.getSafeUserId(),
                    tenantId,
                    aclDomain: tenantId,
                    isSuperuser: false,
                    canonicalSpaceSyncEnabled: true,
                    roles: Object.entries(serverRoles).map(([name, instances]) => ({ name, instances })),
                };
            });
            sdkPermissions = createPermissionStore(jest.fn(), contextFetcher, { persistence: noPersistence() });

            SdkConfig.put({ verjiItopsUrl: "https://itops.test" } as never);
            mocked(initVerjiApiSdkAsync).mockResolvedValue(undefined as never);
            mocked(getVerjiApiSdk).mockResolvedValue({
                permissions: sdkPermissions,
                api: { identityService: { getAccessToken: jest.fn().mockResolvedValue("verji-access-token") } },
            } as never);

            // The store's own init path, as on login. It reads only these two off the client.
            const verjiStore = VerjiPermissionsStore.instance;
            verjiStore.useUnitTestClient({
                getUserId: () => client.getSafeUserId(),
                getAccessToken: () => "macaroon",
            } as unknown as MatrixClient);
            await verjiStore["onReady"]();
            // The page-load fetch, from before the guest org existed.
            await sdkPermissions.ensureContextFresh(TENANT);
        });

        afterEach(async () => {
            // Unmount first, so tearing the store down does not re-render the list outside act().
            cleanup();
            // As on logout: cancels any re-fetch still scheduled and drops the SDK cache.
            await VerjiPermissionsStore.instance["onNotReady"]();
            VerjiPermissionsStore.instance["matrixClient"] = null;
            SdkConfig.reset();
        });

        it("checks, re-fetches on its own, and enables the Rooms + when the Owner row arrives", async () => {
            // The backend has written the Owner row since page load. Hold the response so the
            // Checking state can be observed before it lands.
            serverRoles = { ...STANDARD_USER, "ClientOrganization-Owner": [ORG_A] };
            let respond!: () => void;
            holdResponses = new Promise((resolve) => (respond = resolve));
            const fetchesBefore = contextFetcher.mock.calls.length;

            render(getComponent());

            const button = screen.getByLabelText("Add room");
            expect(button).toHaveAttribute("aria-disabled", "true");
            await expectHint(button, "Checking your access");
            // Nothing in this test asked for it: the render did.
            await waitFor(() => expect(contextFetcher).toHaveBeenCalledTimes(fetchesBefore + 1));
            expect(contextFetcher).toHaveBeenLastCalledWith(expect.anything(), TENANT, undefined);

            respond();

            // The same button, re-rendered: the tooltip still open from the hover now also reads
            // "Add room", so a fresh query by label would be ambiguous.
            await waitFor(() => expect(button).not.toHaveAttribute("aria-disabled", "true"));
            await userEvent.click(button);
            expect(await screen.findByRole("menu")).toBeInTheDocument();
        });

        it("keeps the not-a-member denial, without re-fetching, for a user the context already knows", async () => {
            // A non-member who joined a room in ORG_A: the cached context is current about ORG_A.
            serverRoles = { ...STANDARD_USER, ...JOINED_A_ROOM_IN_ORG_A };
            await sdkPermissions.refreshContext(TENANT);
            const fetchesBefore = contextFetcher.mock.calls.length;

            render(getComponent());

            const button = screen.getByLabelText("Add room");
            expect(button).toHaveAttribute("aria-disabled", "true");
            await expectHint(button, "not a member of this organisation");
            expect(contextFetcher).toHaveBeenCalledTimes(fetchesBefore);
        });
    });

    describe("reactivity", () => {
        it("re-renders the gates when an access context lands after first paint", async () => {
            // The cold-cache first paint is NotGated. When the context arrives the store emits,
            // and that emission is the only thing that re-renders the gates.
            let landed = false;
            jest.spyOn(VerjiPermissionsStore.instance, "isCanonicalSpaceSyncEnabled").mockImplementation(
                (tenantId) => landed && tenantId === TENANT,
            );
            jest.spyOn(VerjiPermissionsStore.instance, "hasRole").mockReturnValue(false);

            render(getComponent());
            expect(screen.getByLabelText("Add room")).not.toHaveAttribute("aria-disabled", "true");
            expect(screen.getByLabelText("Add people")).not.toHaveAttribute("aria-disabled", "true");

            landed = true;
            act(() => {
                VerjiPermissionsStore.instance["bumpVersion"]();
            });

            await waitFor(() => expect(screen.getByLabelText("Add room")).toHaveAttribute("aria-disabled", "true"));
            expect(screen.getByLabelText("Add people")).toHaveAttribute("aria-disabled", "true");
        });
    });

    describe("tenant isolation", () => {
        it("does not apply another tenant's rollout or roles to this space", () => {
            // The store knows tenant-2 only. This space is tenant-1, so it must render as today.
            jest.spyOn(VerjiPermissionsStore.instance, "isCanonicalSpaceSyncEnabled").mockImplementation(
                (tenantId) => tenantId === "tenant-2",
            );
            jest.spyOn(VerjiPermissionsStore.instance, "hasRole").mockReturnValue(false);

            render(getComponent());

            expect(screen.getByLabelText("Add room")).not.toHaveAttribute("aria-disabled", "true");
            expect(screen.getByLabelText("Add people")).not.toHaveAttribute("aria-disabled", "true");
        });
    });
});
