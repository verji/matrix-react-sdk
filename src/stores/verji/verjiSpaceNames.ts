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

import { ClientEvent, MatrixClient, Room } from "matrix-js-sdk/src/matrix";

import { _t, TranslationKey } from "../../languageHandler";
import { resolveVerjiSpaceContext, VerjiSpaceKind } from "./VerjiSpaceContext";

/**
 * VERJI: the OrgUnitCategory names we have translations for.
 *
 * The backend names a category space with an English string (`OrgUnitCategory.DefaultName` in
 * itops-account) and stores it as the space's plain `m.room.name`, leaving translation to the
 * frontend. Each name is its own translation key in the string files, e.g.
 * `"Guest Organizations": "Gjesteorganisasjoner"`. To translate a new category, add its name here
 * and to the string files.
 */
const TRANSLATED_ORG_UNIT_CATEGORY_NAMES = ["Guest Organizations", "Cases", "Projects"];

/** An OrgUnitCategory's name, translated when it is one we have translations for. */
export function getOrgUnitCategoryName(name: string): string {
    return TRANSLATED_ORG_UNIT_CATEGORY_NAMES.includes(name) ? _t(name as TranslationKey) : name;
}

/**
 * Runs while the SDK calculates `room.name`, which during sync is before SpaceStore has built the
 * space tree. So no top-level spaces are passed, and the pre-split fallback in
 * `deriveVerjiSpaceKind` can't apply: a tenant-root personal space of pre-split vintage reads as a
 * category here. That only matters if the tenant is named like a translated category.
 */
function isOrgUnitCategorySpace(room: Room): boolean {
    return resolveVerjiSpaceContext(room, [])?.kind === VerjiSpaceKind.OrgUnitCategory;
}

/**
 * The display name of an OrgUnitCategory space. Returns `null` for any other room, so the caller
 * shows the stored name: a guest organization that happens to be called "Projects" keeps its name.
 *
 * @param room the room being named
 * @param name the room's stored `m.room.name`
 */
export function getOrgUnitCategoryDisplayName(room: Room, name: string): string | null {
    return isOrgUnitCategorySpace(room) ? getOrgUnitCategoryName(name) : null;
}

/**
 * Name each OrgUnitCategory space again once the client has stored it.
 *
 * The name generator finds the room with `client.getRoom()`, but during sync a new room is named
 * before it is stored, so that first name is the stored one. The client emits `ClientEvent.Room`
 * right after storing a new room, when the lookup works.
 */
export function renameOrgUnitCategorySpacesOnceStored(client: MatrixClient): void {
    client.on(ClientEvent.Room, (room) => {
        if (isOrgUnitCategorySpace(room)) room.recalculate();
    });
}
