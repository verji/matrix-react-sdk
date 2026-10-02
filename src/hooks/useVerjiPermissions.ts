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

import SpaceStore from "../stores/spaces/SpaceStore";
import { VerjiPermissionsStore } from "../stores/verji/VerjiPermissionsStore";
import { resolveVerjiSpaceContext, VerjiSpaceContext } from "../stores/verji/VerjiSpaceContext";
import { VerjiGateDecision, VerjiGateReader, VerjiGateVerdict } from "../stores/verji/verjiGates";

/**
 * VERJI: React access to the Hierarchy V2 access-context store.
 *
 * This is the `useSyncExternalStore` shape written by hand, because the fork is on React 17 where
 * that hook does not exist. The bridge store supplies the monotonic version the SDK store lacks;
 * subscribing to it is what re-renders a gate when a tenant's context finally lands.
 *
 * Re-renders are rare by design: the SDK emits only when a record's content actually changed, so a
 * revalidation returning identical data is silent — the common case, since roles change rarely.
 */
function useVerjiStoreVersion(): number {
    const store = VerjiPermissionsStore.instance;
    const [version, setVersion] = useState<number>(store.getVersion);

    useEffect(() => {
        // Re-read on subscribe: the store can have changed between render and effect, and that
        // window is exactly where a cold-cache fetch lands.
        setVersion(store.getVersion());
        return store.subscribe(() => setVersion(store.getVersion()));
    }, [store]);

    return version;
}

/**
 * Resolve a gate decision for the space being rendered.
 *
 * `space` is **the space this component is rendering**, not the globally active one: the room list
 * renders aux buttons for spaces that are not active, and keying the decision by the rendered
 * space's own tenant is what makes a late-arriving fetch for a tenant the user has already left
 * harmless — that response updates its own tenant's cache entry and re-renders a gate that is
 * still reading the tenant it is rendering.
 *
 * The decision is recomputed on every render rather than memoised. It is a handful of synchronous
 * map lookups plus one room-state read, and computing it fresh removes a whole class of staleness
 * bug — a memo keyed on the store version would not notice the space's own state changing.
 *
 * The hook also keeps what the gate read fresh, from effects — never from the gate or during
 * render, because a gate is a pure function and the SDK's read path never fetches:
 * - while it is mounted, it holds a watch on the rendered space's tenant, so the store revalidates
 *   that tenant's copy once it is past the TTL, whether or not anything re-renders;
 * - after a render that reads Checking, it asks the store to re-fetch for that OrgUnit. The store
 *   runs one schedule per OrgUnit and ignores repeats, so asking after every render is safe, and
 *   it means a gate still at Checking after a logout and login asks the new user's store again.
 *
 * @param space the space being rendered, or null when there is none
 * @param gate one of the gate functions in `stores/verji/verjiGates`
 */
export function useVerjiGate(
    space: Room | null | undefined,
    gate: (ctx: VerjiSpaceContext | null, reader: VerjiGateReader) => VerjiGateDecision,
): VerjiGateDecision {
    // Subscribe. The value itself is unused — the reads below go straight to the store.
    void useVerjiStoreVersion();

    const ctx = resolveVerjiSpaceContext(space, SpaceStore.instance.spacePanelSpaces);
    const decision = gate(ctx, VerjiPermissionsStore.instance);

    const tenantId = ctx?.tenantId;
    const checkingOrgUnitId = decision.verdict === VerjiGateVerdict.Checking ? ctx?.orgUnitId : undefined;
    useEffect(() => {
        if (!tenantId) return;
        return VerjiPermissionsStore.instance.watchTenant(tenantId);
    }, [tenantId]);
    useEffect(() => {
        if (tenantId && checkingOrgUnitId) {
            VerjiPermissionsStore.instance.requestOrgUnitRefresh(tenantId, checkingOrgUnitId);
        }
    });

    return decision;
}
