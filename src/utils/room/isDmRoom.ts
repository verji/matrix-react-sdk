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

import { Room } from "matrix-js-sdk/src/matrix";

import DMRoomMap from "../DMRoomMap";

/**
 * VERJI: is this room a direct message?
 *
 * Inviting a third person into a DM is not a supported use of Verji, so every invite affordance
 * inside a DM is removed. This is the single predicate those call sites share — keeping it in
 * one place is what stops the rule being applied to three of the four surfaces.
 *
 * `DMRoomMap.shared()` is the same source `RoomContextMenu` and `RoomGeneralContextMenu` already
 * use for their `isDm` guards. It is optional-chained because the shared instance is only set up
 * once the client is logged in, and these are render paths.
 *
 * @param room the room to test
 * @returns whether the room is a DM
 */
export function isDmRoom(room: Room): boolean {
    return !!DMRoomMap.shared()?.getUserIdForRoomId(room.roomId);
}
