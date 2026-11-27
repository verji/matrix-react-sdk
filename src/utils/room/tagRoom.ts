/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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

import { Room } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import RoomListStore from "../../stores/room-list/RoomListStore";
import { DefaultTagID, TagID } from "../../stores/room-list/models";
import RoomListActions from "../../actions/RoomListActions";
import dis from "../../dispatcher/dispatcher";

/**
 * Toggle tag for a given room
 * @param room The room to tag
 * @param tagId The tag to invert
 */
export function tagRoom(room: Room, tagId: TagID): void {
    if (tagId === DefaultTagID.Favourite || tagId === DefaultTagID.LowPriority) {
        const inverseTag = tagId === DefaultTagID.Favourite ? DefaultTagID.LowPriority : DefaultTagID.Favourite;
        const tags = RoomListStore.instance.getTagsForRoom(room);
        const isApplied = tags.includes(tagId);
        // VERJI: remove the opposite tag only when the room has it. Removing a tag the room does not have is a change
        // of its own on the server, sent alongside the new tag, and a sync taken between the two has left the client
        // without the new tag - a favourite that only took on the second click.
        const removeTag = isApplied ? tagId : tags.includes(inverseTag) ? inverseTag : null;
        const addTag = isApplied ? null : tagId;
        dis.dispatch(RoomListActions.tagRoom(room.client, room, removeTag, addTag, 0));
    } else {
        logger.warn(`Unexpected tag ${tagId} applied to ${room.roomId}`);
    }
}
