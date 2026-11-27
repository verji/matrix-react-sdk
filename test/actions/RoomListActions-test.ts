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

import { mocked } from "jest-mock";
import { MatrixClient, Room } from "matrix-js-sdk/src/matrix";

import RoomListActions from "../../src/actions/RoomListActions";
import Modal from "../../src/Modal";
import { SortAlgorithm } from "../../src/stores/room-list/algorithms/models";
import { DefaultTagID, TagID } from "../../src/stores/room-list/models";
import RoomListStore from "../../src/stores/room-list/RoomListStore";
import { flushPromises, getMockClientWithEventEmitter } from "../test-utils";

// VERJI: a tag change writes the room's tags one change at a time, the new tag first - each write is its own change on
// the server, and a sync taken between two writes in flight has left the client without the new tag.
describe("RoomListActions.tagRoom", () => {
    const roomId = "!room:server.org";
    let client: MatrixClient;
    let room: Room;

    const runTagRoom = (oldTag: TagID | null, newTag: TagID | null): jest.Mock => {
        const dispatch = jest.fn();
        RoomListActions.tagRoom(client, room, oldTag, newTag, 0).fn(dispatch);
        return dispatch;
    };

    const neverSettles = (): Promise<{}> => new Promise(() => {});

    beforeEach(() => {
        client = getMockClientWithEventEmitter({
            deleteRoomTag: jest.fn().mockResolvedValue({}),
            setRoomTag: jest.fn().mockResolvedValue({}),
        });
        room = new Room(roomId, client, "@alice:server.org");
        jest.spyOn(RoomListStore.instance, "getTagSorting").mockReturnValue(SortAlgorithm.Recent);
        jest.spyOn(Modal, "createDialog").mockReturnValue({
            close: jest.fn(),
            finished: Promise.resolve([]),
        } as unknown as ReturnType<typeof Modal.createDialog>);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("adds the new tag first and removes the old one only once it is added", async () => {
        let finishAdding!: () => void;
        mocked(client.setRoomTag).mockReturnValue(new Promise((resolve) => (finishAdding = () => resolve({}))));

        const dispatch = runTagRoom(DefaultTagID.LowPriority, DefaultTagID.Favourite);
        await flushPromises();
        expect(client.setRoomTag).toHaveBeenCalledWith(roomId, DefaultTagID.Favourite, undefined);
        expect(client.deleteRoomTag).not.toHaveBeenCalled();

        finishAdding();
        await flushPromises();
        expect(client.deleteRoomTag).toHaveBeenCalledWith(roomId, DefaultTagID.LowPriority);
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: "RoomListActions.tagRoom.success" }));
    });

    it("does not let a removal that never settles hold back the new tag", async () => {
        mocked(client.deleteRoomTag).mockReturnValue(neverSettles());

        runTagRoom(DefaultTagID.LowPriority, DefaultTagID.Favourite);
        await flushPromises();

        expect(client.setRoomTag).toHaveBeenCalledWith(roomId, DefaultTagID.Favourite, undefined);
    });

    it("keeps the old tag, says so and fails the action when adding the new tag fails", async () => {
        mocked(client.setRoomTag).mockRejectedValue(new Error("add failed"));

        const dispatch = runTagRoom(DefaultTagID.LowPriority, DefaultTagID.Favourite);
        await flushPromises();

        expect(Modal.createDialog).toHaveBeenCalledTimes(1);
        expect(client.deleteRoomTag).not.toHaveBeenCalled();
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: "RoomListActions.tagRoom.failure" }));
    });

    it("says so but still succeeds when removing the old tag fails, as before", async () => {
        mocked(client.deleteRoomTag).mockRejectedValue(new Error("remove failed"));

        const dispatch = runTagRoom(DefaultTagID.LowPriority, DefaultTagID.Favourite);
        await flushPromises();

        expect(client.setRoomTag).toHaveBeenCalledWith(roomId, DefaultTagID.Favourite, undefined);
        expect(Modal.createDialog).toHaveBeenCalledTimes(1);
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: "RoomListActions.tagRoom.success" }));
    });

    it("only removes the tag when there is no new one", async () => {
        const dispatch = runTagRoom(DefaultTagID.Favourite, null);
        await flushPromises();

        expect(client.deleteRoomTag).toHaveBeenCalledWith(roomId, DefaultTagID.Favourite);
        expect(client.setRoomTag).not.toHaveBeenCalled();
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: "RoomListActions.tagRoom.success" }));
    });

    it("only re-adds the tag, with its new order, when a room is reordered within a manually sorted list", async () => {
        mocked(RoomListStore.instance.getTagSorting).mockReturnValue(SortAlgorithm.Manual);
        jest.spyOn(RoomListStore.instance, "orderedLists", "get").mockReturnValue({ [DefaultTagID.Favourite]: [] });

        runTagRoom(DefaultTagID.Favourite, DefaultTagID.Favourite);
        await flushPromises();

        expect(client.setRoomTag).toHaveBeenCalledWith(roomId, DefaultTagID.Favourite, { order: 0.5 });
        expect(client.deleteRoomTag).not.toHaveBeenCalled();
    });

    // verji-roomsublist-module echoes a tag change in its space lists from this payload before the sync arrives
    it("dispatches the room, the old and the new tag as pending before writing", () => {
        const dispatch = runTagRoom(DefaultTagID.LowPriority, DefaultTagID.Favourite);
        expect(dispatch).toHaveBeenNthCalledWith(1, {
            action: "RoomListActions.tagRoom.pending",
            request: { room, oldTag: DefaultTagID.LowPriority, newTag: DefaultTagID.Favourite, metaData: undefined },
        });

        const untagDispatch = runTagRoom(DefaultTagID.Favourite, null);
        expect(untagDispatch).toHaveBeenNthCalledWith(1, {
            action: "RoomListActions.tagRoom.pending",
            request: { room, oldTag: DefaultTagID.Favourite, newTag: null, metaData: undefined },
        });
    });
});
