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

// VERJI: room tiles name the space a room sits in from SpaceStore.getKnownParents(), and recompute on
// UPDATE_KNOWN_PARENTS. These tests use the real SpaceStore to prove the event fires whenever a room's known parents
// change - including the cases where the room sets keyed by space, which SpaceStore also emits, do not change.

import { mocked } from "jest-mock";
import { EventType, Room, RoomStateEvent } from "matrix-js-sdk/src/matrix";

import SpaceStore from "../../../src/stores/spaces/SpaceStore";
import { MetaSpace, UPDATE_HOME_BEHAVIOUR, UPDATE_KNOWN_PARENTS } from "../../../src/stores/spaces";
import * as testUtils from "../../test-utils";
import { mkEvent, stubClient } from "../../test-utils";
import DMRoomMap from "../../../src/utils/DMRoomMap";
import SettingsStore from "../../../src/settings/SettingsStore";
import { SettingLevel } from "../../../src/settings/SettingLevel";
import { MatrixClientPeg } from "../../../src/MatrixClientPeg";
import { roomListSpaceContextDetails } from "../../../src/utils/i18n-helpers";

jest.useFakeTimers();

// @ts-ignore
DMRoomMap.sharedInstance = { getUserIdForRoomId: jest.fn(() => undefined), getDMRoomsForUserId: jest.fn(() => []) };

describe("SpaceStore known parents (VERJI)", () => {
    stubClient();
    const store = SpaceStore.instance;
    const client = MatrixClientPeg.safeGet();
    let rooms: Room[] = [];
    const mkRoom = (roomId: string): Room => testUtils.mkRoom(client, roomId, rooms);
    const mkSpace = (spaceId: string, children: string[] = []): Room =>
        testUtils.mkSpace(client, spaceId, rooms, children);

    const run = async (): Promise<void> => {
        mocked(client).getRoom.mockImplementation((roomId) => rooms.find((room) => room.roomId === roomId) || null);
        mocked(client).getRoomUpgradeHistory.mockImplementation((roomId) => {
            const room = rooms.find((room) => room.roomId === roomId);
            return room ? [room] : [];
        });
        await testUtils.setupAsyncStoreWithClient(store, client);
        jest.runOnlyPendingTimers();
    };

    // Sets the space's m.space.child events - `children` present, `removed` removed (an event without `via`, as
    // Matrix removes a child) - and delivers the last one as sync would
    const setChildren = (spaceId: string, children: string[], removed: string[] = []): void => {
        const mkChildEvent = (id: string, content: object): ReturnType<typeof mkEvent> =>
            mkEvent({
                event: true,
                type: EventType.SpaceChild,
                room: spaceId,
                user: client.getUserId()!,
                skey: id,
                content,
                ts: Date.now(),
            });
        const events = [
            ...children.map((id) => mkChildEvent(id, { via: [] })),
            ...removed.map((id) => mkChildEvent(id, {})),
        ];
        const space = client.getRoom(spaceId)!;
        mocked(space.currentState).getStateEvents.mockImplementation(testUtils.mockStateEventImplementation(events));
        client.emit(RoomStateEvent.Events, events[events.length - 1], space.currentState, null);
    };

    const emittedDuring = (fn: () => void): unknown[] => {
        const emitSpy = jest.spyOn(store, "emit").mockClear();
        fn();
        const emitted = emitSpy.mock.calls.map(([event]) => event);
        emitSpy.mockRestore();
        return emitted;
    };

    beforeEach(async () => {
        jest.runOnlyPendingTimers();
        mocked(client).getVisibleRooms.mockReturnValue((rooms = []));
        await SettingsStore.setValue("Spaces.enabledMetaSpaces", null, SettingLevel.DEVICE, {
            [MetaSpace.Home]: true,
            [MetaSpace.Favourites]: true,
            [MetaSpace.People]: true,
            [MetaSpace.Orphans]: true,
        });
    });

    afterEach(async () => {
        await testUtils.resetAsyncStoreWithClient(store);
    });

    it("announces a room created in a nested space getting its m.space.child, which no room set reflects", async () => {
        // Element puts m.space.parent in a new room's initial state and sends the space's m.space.child after, so
        // the room is listed in Root (through its m.space.parent) before its known parents name Nested
        const room = mkRoom("!created:server");
        const nested = mkSpace("!nested:server");
        mkSpace("!root:server", [nested.roomId]);
        mocked(room.currentState).getStateEvents.mockImplementation(
            testUtils.mockStateEventImplementation([
                mkEvent({
                    event: true,
                    type: EventType.SpaceParent,
                    room: room.roomId,
                    user: client.getUserId()!,
                    skey: nested.roomId,
                    content: { via: [], canonical: true },
                    ts: Date.now(),
                }),
            ]),
        );
        mocked(nested.currentState).maySendStateEvent.mockImplementation(
            (eventType: string, userId: string) => eventType !== EventType.SpaceChild || userId === client.getUserId(),
        );
        await run();
        store.setActiveSpace("!root:server", false);
        expect(store.isRoomInSpace("!root:server", room.roomId)).toBe(true);
        expect(roomListSpaceContextDetails(room, store.activeSpace)).toBeNull();

        const emitted = emittedDuring(() => setChildren(nested.roomId, [room.roomId]));

        expect(roomListSpaceContextDetails(room, store.activeSpace)?.details).toBe(nested.roomId);
        expect(emitted).not.toContain("!root:server");
        expect(emitted).toContain(UPDATE_KNOWN_PARENTS);
    });

    it("announces a favourite room being added to a space while Favourites is viewed", async () => {
        const room = mkRoom("!fav:server");
        room.tags = { "m.favourite": { order: 0.5 } };
        const space = mkSpace("!space:server");
        await run();
        store.setActiveSpace(MetaSpace.Favourites, false);
        expect(roomListSpaceContextDetails(room, store.activeSpace)).toBeNull();

        const emitted = emittedDuring(() => setChildren(space.roomId, [room.roomId]));

        expect(roomListSpaceContextDetails(room, store.activeSpace)?.details).toBe(space.roomId);
        expect(emitted).not.toContain(MetaSpace.Favourites);
        expect(emitted).toContain(UPDATE_KNOWN_PARENTS);
    });

    it("announces a room being added to a space while Home shows all rooms", async () => {
        const room = mkRoom("!plain:server");
        const space = mkSpace("!space:server");
        await run();
        if (!store.allRoomsInHome) {
            const homeBehaviourChanged = testUtils.emitPromise(store, UPDATE_HOME_BEHAVIOUR);
            await SettingsStore.setValue("Spaces.allRoomsInHome", null, SettingLevel.DEVICE, true);
            jest.runOnlyPendingTimers();
            await homeBehaviourChanged;
        }
        store.setActiveSpace(MetaSpace.Home, false);

        const emitted = emittedDuring(() => setChildren(space.roomId, [room.roomId]));

        expect(roomListSpaceContextDetails(room, store.activeSpace)?.details).toBe(space.roomId);
        expect(emitted).not.toContain(MetaSpace.Home);
        expect(emitted).toContain(UPDATE_KNOWN_PARENTS);
        await SettingsStore.setValue("Spaces.allRoomsInHome", null, SettingLevel.DEVICE, false);
        jest.runOnlyPendingTimers();
    });

    it("announces a room leaving a space", async () => {
        const room = mkRoom("!leaving:server");
        const space = mkSpace("!space:server", [room.roomId]);
        await run();
        expect(store.getKnownParents(room.roomId).has(space.roomId)).toBe(true);

        const emitted = emittedDuring(() => setChildren(space.roomId, [], [room.roomId]));

        expect(store.getKnownParents(room.roomId).size).toBe(0);
        expect(emitted).toContain(UPDATE_KNOWN_PARENTS);
    });

    it("announces nothing when a space's children are re-sent unchanged", async () => {
        const room = mkRoom("!steady:server");
        const space = mkSpace("!space:server", [room.roomId]);
        await run();

        const emitted = emittedDuring(() => setChildren(space.roomId, [room.roomId]));

        expect(emitted).not.toContain(UPDATE_KNOWN_PARENTS);
    });

    it("names the space a room sits in two levels below the active space, and not its space outside it", async () => {
        const room = mkRoom("!deep:server");
        mkSpace("!elsewhere:server", [room.roomId]);
        mkSpace("!orgunit:server", [room.roomId]);
        mkSpace("!category:server", ["!orgunit:server"]);
        mkSpace("!root:server", ["!category:server"]);
        await run();

        expect(roomListSpaceContextDetails(room, "!root:server")?.details).toBe("!orgunit:server");
        expect(roomListSpaceContextDetails(room, "!category:server")?.details).toBe("!orgunit:server");
        expect(roomListSpaceContextDetails(room, "!orgunit:server")).toBeNull();
    });
});
