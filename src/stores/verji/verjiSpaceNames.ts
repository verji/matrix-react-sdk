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

import { _t, _td, TranslationKey } from "../../languageHandler";
import { resolveVerjiSpaceContext, VerjiSpaceKind } from "./VerjiSpaceContext";

/**
 * VERJI: the OrgUnitCategory names the client knows how to translate.
 *
 * The backend names a category space with an English string (`OrgUnitCategory.DefaultName` in
 * itops-account) and stores it as the space's plain `m.room.name`, leaving translation to the
 * frontend. Keys are literal `_td()` calls, so the i18n extractor keeps them.
 */
const ORG_UNIT_CATEGORY_NAMES = new Map<string, TranslationKey>([
    ["Guest Organizations", _td("verji|org_unit_category|guest_organizations")],
    ["Cases", _td("verji|org_unit_category|cases")],
    ["Projects", _td("verji|org_unit_category|projects")],
]);

/**
 * The display name of an OrgUnitCategory space: its stored name translated, when it is one we know.
 *
 * Returns `null` for any other space, and for a category name with no translation, so the caller
 * shows the stored name. Only categories are translated: a guest organization that happens to be
 * called "Projects" keeps its name.
 *
 * Called while the SDK calculates `room.name`, which during sync is before SpaceStore has built the
 * space tree. So no top-level spaces are passed, and the pre-split fallback in
 * `deriveVerjiSpaceKind` can't apply: a tenant-root personal space of pre-split vintage reads
 * as a category here. That only matters if the tenant is literally named like a category.
 *
 * @param room the room being named
 * @param name the room's stored `m.room.name`
 */
export function getOrgUnitCategoryDisplayName(room: Room, name: string): string | null {
    const key = ORG_UNIT_CATEGORY_NAMES.get(name);
    if (!key) return null;
    if (resolveVerjiSpaceContext(room, [])?.kind !== VerjiSpaceKind.OrgUnitCategory) return null;
    return _t(key);
}
