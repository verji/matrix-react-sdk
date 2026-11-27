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

// VERJI: a tag move writes the room's tags one change at a time - each write is its own change on the server, and a
// sync taken between two writes in flight has left the client without the new tag.
describe("RoomListActions.tagRoom", () => {
    const roomId = "!room:server.org";
    let client: MatrixClient;
    let room: Room;

    const runTagRoom = (oldTag: TagID | null, newTag: TagID | null): jest.Mock => {
        const dispatch = jest.fn();
        RoomListActions.tagRoom(client, room, oldTag, newTag, 0).fn(dispatch);
        return dispatch;
    };

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

    it("adds a tag with a single request when there is no old tag to remove", async () => {
        const dispatch = runTagRoom(null, DefaultTagID.Favourite);
        await flushPromises();

        expect(client.deleteRoomTag).not.toHaveBeenCalled();
        expect(client.setRoomTag).toHaveBeenCalledWith(roomId, DefaultTagID.Favourite, undefined);
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: "RoomListActions.tagRoom.success" }));
    });

    it("adds the new tag only once the old one is removed", async () => {
        let finishRemoval!: () => void;
        mocked(client.deleteRoomTag).mockReturnValue(new Promise((resolve) => (finishRemoval = () => resolve({}))));

        const dispatch = runTagRoom(DefaultTagID.LowPriority, DefaultTagID.Favourite);
        await flushPromises();
        expect(client.deleteRoomTag).toHaveBeenCalledWith(roomId, DefaultTagID.LowPriority);
        expect(client.setRoomTag).not.toHaveBeenCalled();

        finishRemoval();
        await flushPromises();
        expect(client.setRoomTag).toHaveBeenCalledWith(roomId, DefaultTagID.Favourite, undefined);
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: "RoomListActions.tagRoom.success" }));
    });

    it("still adds the new tag when removing the old one fails, and says so", async () => {
        mocked(client.deleteRoomTag).mockRejectedValue(new Error("remove failed"));

        const dispatch = runTagRoom(DefaultTagID.LowPriority, DefaultTagID.Favourite);
        await flushPromises();

        expect(Modal.createDialog).toHaveBeenCalledTimes(1);
        expect(client.setRoomTag).toHaveBeenCalledWith(roomId, DefaultTagID.Favourite, undefined);
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: "RoomListActions.tagRoom.success" }));
    });

    it("fails the action when adding the new tag fails", async () => {
        mocked(client.setRoomTag).mockRejectedValue(new Error("add failed"));

        const dispatch = runTagRoom(DefaultTagID.LowPriority, DefaultTagID.Favourite);
        await flushPromises();

        expect(Modal.createDialog).toHaveBeenCalledTimes(1);
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: "RoomListActions.tagRoom.failure" }));
    });

    it("only removes the tag when there is no new one", async () => {
        const dispatch = runTagRoom(DefaultTagID.Favourite, null);
        await flushPromises();

        expect(client.deleteRoomTag).toHaveBeenCalledWith(roomId, DefaultTagID.Favourite);
        expect(client.setRoomTag).not.toHaveBeenCalled();
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: "RoomListActions.tagRoom.success" }));
    });
});
