/*
Copyright 2022 The Matrix.org Foundation C.I.C.

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
import { render, screen, act, RenderResult } from "@testing-library/react";
import { mocked, Mocked } from "jest-mock";
import {
    MatrixClient,
    PendingEventOrdering,
    Room,
    MatrixEvent,
    RoomEvent,
    RoomStateEvent,
    Thread,
} from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { Widget } from "matrix-widget-api";

import type { RoomMember } from "matrix-js-sdk/src/matrix";
import type { ClientWidgetApi } from "matrix-widget-api";
import {
    stubClient,
    mkRoomMember,
    MockedCall,
    useMockedCalls,
    setupAsyncStoreWithClient,
    filterConsole,
    flushPromises,
    mkMessage,
    useMockMediaDevices,
} from "../../../test-utils";
import { CallStore } from "../../../../src/stores/CallStore";
import RoomTile from "../../../../src/components/views/rooms/RoomTile";
import { DefaultTagID } from "../../../../src/stores/room-list/models";
import DMRoomMap from "../../../../src/utils/DMRoomMap";
import PlatformPeg from "../../../../src/PlatformPeg";
import BasePlatform from "../../../../src/BasePlatform";
import { WidgetMessagingStore } from "../../../../src/stores/widgets/WidgetMessagingStore";
import { VoiceBroadcastInfoState } from "../../../../src/voice-broadcast";
import { mkVoiceBroadcastInfoStateEvent } from "../../../voice-broadcast/utils/test-utils";
import { TestSdkContext } from "../../../TestSdkContext";
import { SDKContext } from "../../../../src/contexts/SDKContext";
import { shouldShowComponent } from "../../../../src/customisations/helpers/UIComponents";
import { UIComponent } from "../../../../src/settings/UIFeature";
import { MessagePreviewStore } from "../../../../src/stores/room-list/MessagePreviewStore";
import { MatrixClientPeg } from "../../../../src/MatrixClientPeg";
import SettingsStore from "../../../../src/settings/SettingsStore";
import { ConnectionState } from "../../../../src/models/Call";
import SpaceStore from "../../../../src/stores/spaces/SpaceStore";
import { MetaSpace, SpaceKey, UPDATE_KNOWN_PARENTS, UPDATE_SELECTED_SPACE } from "../../../../src/stores/spaces";

jest.mock("../../../../src/customisations/helpers/UIComponents", () => ({
    shouldShowComponent: jest.fn(),
}));

describe("RoomTile", () => {
    jest.spyOn(PlatformPeg, "get").mockReturnValue({
        overrideBrowserShortcuts: () => false,
    } as unknown as BasePlatform);
    useMockedCalls();

    const setUpVoiceBroadcast = async (state: VoiceBroadcastInfoState): Promise<void> => {
        voiceBroadcastInfoEvent = mkVoiceBroadcastInfoStateEvent(
            room.roomId,
            state,
            client.getSafeUserId(),
            client.getDeviceId()!,
        );

        await act(async () => {
            room.currentState.setStateEvents([voiceBroadcastInfoEvent]);
            await flushPromises();
        });
    };

    const renderRoomTile = (): RenderResult => {
        return render(
            <SDKContext.Provider value={sdkContext}>
                <RoomTile
                    room={room}
                    showMessagePreview={showMessagePreview}
                    isMinimized={false}
                    tag={DefaultTagID.Untagged}
                />
            </SDKContext.Provider>,
        );
    };

    let client: Mocked<MatrixClient>;
    let voiceBroadcastInfoEvent: MatrixEvent;
    let room: Room;
    let sdkContext: TestSdkContext;
    let showMessagePreview = false;

    filterConsole(
        // irrelevant for this test
        "Room !1:example.org does not have an m.room.create event",
    );

    const addMessageToRoom = (ts: number) => {
        const message = mkMessage({
            event: true,
            room: room.roomId,
            msg: "test message",
            user: client.getSafeUserId(),
            ts,
        });

        room.timeline.push(message);
    };

    const addThreadMessageToRoom = (ts: number) => {
        const message = mkMessage({
            event: true,
            room: room.roomId,
            msg: "test thread reply",
            user: client.getSafeUserId(),
            ts,
        });

        // Mock thread reply for tests.
        jest.spyOn(room, "getThreads").mockReturnValue([
            // @ts-ignore
            {
                lastReply: () => message,
                timeline: [],
            } as Thread,
        ]);
    };

    beforeEach(() => {
        useMockMediaDevices();
        sdkContext = new TestSdkContext();

        client = mocked(stubClient());
        sdkContext.client = client;
        DMRoomMap.makeShared(client);

        room = new Room("!1:example.org", client, "@alice:example.org", {
            pendingEventOrdering: PendingEventOrdering.Detached,
        });

        client.getRoom.mockImplementation((roomId) => (roomId === room.roomId ? room : null));
        client.getRooms.mockReturnValue([room]);
        client.reEmitter.reEmit(room, [RoomStateEvent.Events]);
    });

    afterEach(() => {
        // @ts-ignore
        MessagePreviewStore.instance.previews = new Map<string, Map<TagID | TAG_ANY, MessagePreview | null>>();
        jest.clearAllMocks();
    });

    describe("when message previews are not enabled", () => {
        it("should render the room", () => {
            mocked(shouldShowComponent).mockReturnValue(true);
            const { container } = renderRoomTile();
            expect(container).toMatchSnapshot();
            expect(container.querySelector(".mx_RoomTile_sticky")).not.toBeInTheDocument();
        });

        it("does not render the room options context menu when UIComponent customisations disable room options", () => {
            mocked(shouldShowComponent).mockReturnValue(false);
            renderRoomTile();
            expect(shouldShowComponent).toHaveBeenCalledWith(UIComponent.RoomOptionsMenu);
            expect(screen.queryByRole("button", { name: "Room options" })).not.toBeInTheDocument();
        });

        it("renders the room options context menu when UIComponent customisations enable room options", () => {
            mocked(shouldShowComponent).mockReturnValue(true);
            renderRoomTile();
            expect(shouldShowComponent).toHaveBeenCalledWith(UIComponent.RoomOptionsMenu);
            expect(screen.queryByRole("button", { name: "Room options" })).toBeInTheDocument();
        });

        it("does not render the room options context menu when knocked to the room", () => {
            jest.spyOn(SettingsStore, "getValue").mockImplementation((name) => {
                return name === "feature_ask_to_join";
            });
            mocked(shouldShowComponent).mockReturnValue(true);
            jest.spyOn(room, "getMyMembership").mockReturnValue(KnownMembership.Knock);
            const { container } = renderRoomTile();
            expect(container.querySelector(".mx_RoomTile_sticky")).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Room options" })).not.toBeInTheDocument();
        });

        it("does not render the room options context menu when knock has been denied", () => {
            jest.spyOn(SettingsStore, "getValue").mockImplementation((name) => {
                return name === "feature_ask_to_join";
            });
            mocked(shouldShowComponent).mockReturnValue(true);
            const roomMember = mkRoomMember(
                room.roomId,
                MatrixClientPeg.get()!.getSafeUserId(),
                KnownMembership.Leave,
                true,
                {
                    membership: KnownMembership.Knock,
                },
            );
            jest.spyOn(room, "getMember").mockReturnValue(roomMember);
            const { container } = renderRoomTile();
            expect(container.querySelector(".mx_RoomTile_sticky")).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Room options" })).not.toBeInTheDocument();
        });

        describe("when a call starts", () => {
            let call: MockedCall;
            let widget: Widget;

            beforeEach(() => {
                setupAsyncStoreWithClient(CallStore.instance, client);
                setupAsyncStoreWithClient(WidgetMessagingStore.instance, client);

                MockedCall.create(room, "1");
                const maybeCall = CallStore.instance.getCall(room.roomId);
                if (!(maybeCall instanceof MockedCall)) throw new Error("Failed to create call");
                call = maybeCall;

                widget = new Widget(call.widget);
                WidgetMessagingStore.instance.storeMessaging(widget, room.roomId, {
                    stop: () => {},
                } as unknown as ClientWidgetApi);
            });

            afterEach(() => {
                call.destroy();
                client.reEmitter.stopReEmitting(room, [RoomStateEvent.Events]);
                WidgetMessagingStore.instance.stopMessaging(widget, room.roomId);
            });

            it("tracks connection state", async () => {
                renderRoomTile();
                screen.getByText("Video");

                let completeWidgetLoading: () => void = () => {};
                const widgetLoadingCompleted = new Promise<void>((resolve) => (completeWidgetLoading = resolve));

                // Insert an await point in the connection method so we can inspect
                // the intermediate connecting state
                let completeConnection: () => void = () => {};
                const connectionCompleted = new Promise<void>((resolve) => (completeConnection = resolve));

                let completeLobby: () => void = () => {};
                const lobbyCompleted = new Promise<void>((resolve) => (completeLobby = resolve));

                jest.spyOn(call, "performConnection").mockImplementation(async () => {
                    call.setConnectionState(ConnectionState.WidgetLoading);
                    await widgetLoadingCompleted;
                    call.setConnectionState(ConnectionState.Lobby);
                    await lobbyCompleted;
                    call.setConnectionState(ConnectionState.Connecting);
                    await connectionCompleted;
                });

                await Promise.all([
                    (async () => {
                        await screen.findByText("Loading…");
                        completeWidgetLoading();
                        await screen.findByText("Lobby");
                        completeLobby();
                        await screen.findByText("Joining…");
                        completeConnection();
                        await screen.findByText("Joined");
                    })(),
                    call.start(),
                ]);

                await Promise.all([screen.findByText("Video"), call.disconnect()]);
            });

            it("tracks participants", () => {
                renderRoomTile();
                const alice: [RoomMember, Set<string>] = [
                    mkRoomMember(room.roomId, "@alice:example.org"),
                    new Set(["a"]),
                ];
                const bob: [RoomMember, Set<string>] = [
                    mkRoomMember(room.roomId, "@bob:example.org"),
                    new Set(["b1", "b2"]),
                ];
                const carol: [RoomMember, Set<string>] = [
                    mkRoomMember(room.roomId, "@carol:example.org"),
                    new Set(["c"]),
                ];

                expect(screen.queryByLabelText(/participant/)).toBe(null);

                act(() => {
                    call.participants = new Map([alice]);
                });
                expect(screen.getByLabelText("1 person joined").textContent).toBe("1");

                act(() => {
                    call.participants = new Map([alice, bob, carol]);
                });
                expect(screen.getByLabelText("4 people joined").textContent).toBe("4");

                act(() => {
                    call.participants = new Map();
                });
                expect(screen.queryByLabelText(/participant/)).toBe(null);
            });

            describe("and a live broadcast starts", () => {
                beforeEach(async () => {
                    renderRoomTile();
                    await setUpVoiceBroadcast(VoiceBroadcastInfoState.Started);
                });

                it("should still render the call subtitle", () => {
                    expect(screen.queryByText("Video")).toBeInTheDocument();
                    expect(screen.queryByText("Live")).not.toBeInTheDocument();
                });
            });
        });

        describe("when a live voice broadcast starts", () => {
            beforeEach(async () => {
                renderRoomTile();
                await setUpVoiceBroadcast(VoiceBroadcastInfoState.Started);
            });

            it("should render the »Live« subtitle", () => {
                expect(screen.queryByText("Live")).toBeInTheDocument();
            });

            describe("and the broadcast stops", () => {
                beforeEach(async () => {
                    const stopEvent = mkVoiceBroadcastInfoStateEvent(
                        room.roomId,
                        VoiceBroadcastInfoState.Stopped,
                        client.getSafeUserId(),
                        client.getDeviceId()!,
                        voiceBroadcastInfoEvent,
                    );
                    await act(async () => {
                        room.currentState.setStateEvents([stopEvent]);
                        await flushPromises();
                    });
                });

                it("should not render the »Live« subtitle", () => {
                    expect(screen.queryByText("Live")).not.toBeInTheDocument();
                });
            });
        });
    });

    describe("when message previews are enabled", () => {
        beforeEach(() => {
            showMessagePreview = true;
        });

        it("should render a room without a message as expected", async () => {
            const renderResult = renderRoomTile();
            // flush promises here because the preview is created asynchronously
            await flushPromises();
            expect(renderResult.asFragment()).toMatchSnapshot();
        });

        describe("and there is a message in the room", () => {
            beforeEach(() => {
                addMessageToRoom(23);
            });

            it("should render as expected", async () => {
                const renderResult = renderRoomTile();
                expect(await screen.findByText("test message")).toBeInTheDocument();
                expect(renderResult.asFragment()).toMatchSnapshot();
            });
        });

        describe("and there is a message in a thread", () => {
            beforeEach(() => {
                addThreadMessageToRoom(23);
            });

            it("should render as expected", async () => {
                const renderResult = renderRoomTile();
                expect(await screen.findByText("test thread reply")).toBeInTheDocument();
                expect(renderResult.asFragment()).toMatchSnapshot();
            });
        });

        describe("and there is a message and a thread without a reply", () => {
            beforeEach(() => {
                addMessageToRoom(23);

                // Mock thread reply for tests.
                jest.spyOn(room, "getThreads").mockReturnValue([
                    // @ts-ignore
                    {
                        lastReply: () => null,
                        timeline: [],
                        findEventById: () => {},
                    } as Thread,
                ]);
            });

            it("should render the message preview", async () => {
                renderRoomTile();
                expect(await screen.findByText("test message")).toBeInTheDocument();
            });
        });
    });

    describe("VERJI: the space a room sits in", () => {
        const rootId = "!root:example.org";
        let orgUnit: Room;
        let activeSpace: SpaceKey;
        let parentsOfRoom: string[];
        let spies: jest.SpyInstance[];

        const spaceName = (container: HTMLElement): string | null =>
            container.querySelector(".mx_RoomTile_spaceContext")?.textContent ?? null;

        beforeEach(() => {
            mocked(shouldShowComponent).mockReturnValue(true);
            orgUnit = new Room("!orgunit:example.org", client, client.getSafeUserId());
            orgUnit.name = "Org unit";
            client.getRoom.mockImplementation((roomId) => [room, orgUnit].find((r) => r.roomId === roomId) ?? null);
            // Root > Org unit > room
            activeSpace = rootId;
            parentsOfRoom = [orgUnit.roomId];
            spies = [
                jest.spyOn(SpaceStore.instance, "activeSpace", "get").mockImplementation(() => activeSpace),
                jest
                    .spyOn(SpaceStore.instance, "getKnownParents")
                    .mockImplementation(
                        (roomId) =>
                            new Set(roomId === room.roomId ? parentsOfRoom : roomId === orgUnit.roomId ? [rootId] : []),
                    ),
            ];
        });

        afterEach(() => {
            spies.forEach((spy) => spy.mockRestore());
        });

        it("shows the space a room sits in after its name, in a space that space is nested in", () => {
            const { container } = renderRoomTile();
            expect(spaceName(container)).toBe("Org unit");
            expect(container.querySelector(".mx_RoomTile_title")).toContainElement(
                container.querySelector(".mx_RoomTile_spaceContext") as HTMLElement,
            );
            expect(screen.getByRole("treeitem").getAttribute("aria-label")).toMatch(/ In Org unit\.$/);
            // a long room name must not push the space name out of sight, and hovering shows both in full
            const title = container.querySelector(".mx_RoomTile_title")!;
            expect(title).toHaveClass("mx_RoomTile_titleWithSpaceContext");
            expect(title.getAttribute("title")).toMatch(/ In Org unit\.$/);
        });

        it("shows no space name for a room directly in the active space", () => {
            activeSpace = orgUnit.roomId;
            const { container } = renderRoomTile();
            expect(spaceName(container)).toBeNull();
            expect(screen.getByRole("treeitem").getAttribute("aria-label")).not.toMatch(/Org unit/);
            const title = container.querySelector(".mx_RoomTile_title")!;
            expect(title).not.toHaveClass("mx_RoomTile_titleWithSpaceContext");
            expect(title.getAttribute("title")).not.toMatch(/Org unit/);
        });

        it("follows a switch of space", () => {
            const { container } = renderRoomTile();
            expect(spaceName(container)).toBe("Org unit");

            activeSpace = orgUnit.roomId;
            act(() => {
                SpaceStore.instance.emit(UPDATE_SELECTED_SPACE, activeSpace);
            });
            expect(spaceName(container)).toBeNull();

            activeSpace = rootId;
            act(() => {
                SpaceStore.instance.emit(UPDATE_SELECTED_SPACE, activeSpace);
            });
            expect(spaceName(container)).toBe("Org unit");
        });

        it("follows the room moving between spaces inside the active space", () => {
            const { container } = renderRoomTile();
            expect(spaceName(container)).toBe("Org unit");

            parentsOfRoom = [rootId];
            act(() => {
                SpaceStore.instance.emit(UPDATE_KNOWN_PARENTS);
            });
            expect(spaceName(container)).toBeNull();
        });

        it("follows the room being added to a space while a meta space is viewed", () => {
            activeSpace = MetaSpace.Favourites;
            parentsOfRoom = [];
            const { container } = renderRoomTile();
            expect(spaceName(container)).toBeNull();

            parentsOfRoom = [orgUnit.roomId];
            act(() => {
                SpaceStore.instance.emit(UPDATE_KNOWN_PARENTS);
            });
            expect(spaceName(container)).toBe("Org unit");
        });

        it("follows a rename of the space", () => {
            const { container } = renderRoomTile();
            orgUnit.name = "Renamed unit";
            act(() => {
                client.emit(RoomEvent.Name, orgUnit);
            });
            expect(spaceName(container)).toBe("Renamed unit");
        });

        it("stops listening when unmounted", () => {
            const selectedBefore = SpaceStore.instance.listenerCount(UPDATE_SELECTED_SPACE);
            const parentsBefore = SpaceStore.instance.listenerCount(UPDATE_KNOWN_PARENTS);
            const onSpy = jest.spyOn(client, "on");
            const offSpy = jest.spyOn(client, "off");
            const { unmount } = renderRoomTile();
            expect(SpaceStore.instance.listenerCount(UPDATE_SELECTED_SPACE)).toBe(selectedBefore + 1);
            expect(SpaceStore.instance.listenerCount(UPDATE_KNOWN_PARENTS)).toBe(parentsBefore + 1);
            const nameListeners = onSpy.mock.calls.filter(([event]) => event === RoomEvent.Name).map(([, fn]) => fn);
            expect(nameListeners).toHaveLength(1);

            unmount();
            expect(SpaceStore.instance.listenerCount(UPDATE_SELECTED_SPACE)).toBe(selectedBefore);
            expect(SpaceStore.instance.listenerCount(UPDATE_KNOWN_PARENTS)).toBe(parentsBefore);
            expect(offSpy).toHaveBeenCalledWith(RoomEvent.Name, nameListeners[0]);
        });
    });
});
