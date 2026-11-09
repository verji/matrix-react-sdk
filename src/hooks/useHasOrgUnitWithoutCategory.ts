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

import { useEffect, useState } from "react";
import { Room } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import SpaceStore from "../stores/spaces/SpaceStore";
import { VerjiPermissionsStore } from "../stores/verji/VerjiPermissionsStore";
import { resolveVerjiSpaceContext } from "../stores/verji/VerjiSpaceContext";
import {
    askHasOrgUnitWithoutCategory,
    describeError,
    getOrgUnitsWithoutCategory,
    knownHasOrgUnitWithoutCategory,
} from "../stores/verji/verjiOrgUnitRooms";
import { isTenantPrimaryContact } from "../stores/verji/verjiRoles";

/**
 * VERJI: does the user have an org unit of the rendered space's tenant that has no category yet and
 * that they may give one (verji/verji-src#2117)? The half of "Add existing Guest Organization" the
 * access context cannot answer: it says whom an org unit belongs to, not whether it has a category.
 *
 * The tenant's PrimaryContact may bring in any org unit of the tenant, and is answered yes at once.
 * Anyone else is asked of the Organization API once per tenant for the session, and the answer is
 * kept (`knownHasOrgUnitWithoutCategory`) until the access context changes or a guest org is
 * brought in, so a menu shows the option to an Owner only when one of theirs is waiting, a moment
 * after it first opens and at once after that. Menus that open before the answer lands share the
 * one question (`askHasOrgUnitWithoutCategory`). A failed answer reads as no, and is not kept: the
 * option is left out, as for someone who has nothing to bring in, until a menu asks again.
 *
 * Reads the access context synchronously, as a gate does; the component re-renders on its changes
 * through `useVerjiGate`, which it calls for the same space.
 *
 * @param space the space being rendered
 * @param asked whether to ask at all: false, as when the gate hides the option or the Organization
 *     API is not configured, is answered no at once and sends nothing
 */
export function useHasOrgUnitWithoutCategory(space: Room | null | undefined, asked: boolean): boolean {
    const store = VerjiPermissionsStore.instance;
    const ctx = resolveVerjiSpaceContext(space, SpaceStore.instance.spacePanelSpaces);
    const tenantId = asked ? ctx?.tenantId : undefined;
    const primaryContact = !!tenantId && isTenantPrimaryContact(store, tenantId);
    // The access context the answer is asked under: when it changes, a kept answer no longer holds.
    const version = store.getVersion();
    const known = tenantId && !primaryContact ? knownHasOrgUnitWithoutCategory(tenantId, version) : undefined;
    const client = space?.client;
    const [answer, setAnswer] = useState<{ tenantId: string; version: number; has: boolean } | null>(null);

    useEffect(() => {
        if (!tenantId || primaryContact || !client || known !== undefined) return;
        let mounted = true;
        // Kept for the next menu even when this one has closed; shared with any menu that opens meanwhile.
        askHasOrgUnitWithoutCategory(tenantId, version, async () => {
            try {
                return (await getOrgUnitsWithoutCategory(client, tenantId, store)).length > 0;
            } catch (error) {
                logger.warn("[Verji.OrgUnitRooms] Could not ask for the org units to bring in", describeError(error));
                throw error;
            }
        }).then(
            (has) => {
                if (mounted) setAnswer({ tenantId, version, has });
            },
            () => {
                if (mounted) setAnswer({ tenantId, version, has: false });
            },
        );
        return () => {
            mounted = false;
        };
    }, [client, store, tenantId, primaryContact, version, known]);

    if (!tenantId) return false;
    if (primaryContact) return true;
    if (known !== undefined) return known;
    // Only the answer for this tenant, under this access context: never another space's.
    return answer?.tenantId === tenantId && answer.version === version && answer.has;
}
