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

/**
 * VERJI: what the client can know about the space it is rendering.
 *
 * Two facts decide every Hierarchy V2 gate: **the space says which OrgUnit it is**, and the access
 * context says **what you are on that OrgUnit**. This module supplies the first half.
 *
 * Everything here is read **synchronously** off `room.currentState`. Never reach for
 * `client.getStateEvent()`, which is an async `/state/` round-trip: gates render synchronously or
 * they flicker, and a gate that flickers from enabled to disabled has already shown the user an
 * affordance they do not have.
 *
 * Always resolve from **the space being rendered**, never from a global "active tenant" singleton.
 * The room list renders aux buttons for spaces that are not the active one, and keying every read
 * by the rendered space's own tenant id is exactly what makes a late-arriving fetch for a tenant
 * the user has already left harmless.
 */

/** `app.verji.tenant_info` — which tenant this space belongs to. */
const EV_TENANT_INFO = "app.verji.tenant_info";
/** `app.verji.org_unit_info` — which OrgUnit this space backs. Present on OrgUnit spaces only. */
const EV_ORG_UNIT_INFO = "app.verji.org_unit_info";
/** `app.verji.canonical_sibling_space` — the canonical this personal space mirrors (post-split). */
const EV_CANONICAL_SIBLING_SPACE = "app.verji.canonical_sibling_space";
/** `app.verji.canonical_parent_space` — the canonical parent (and, pre-split, the mirrored one). */
const EV_CANONICAL_PARENT_SPACE = "app.verji.canonical_parent_space";

/**
 * The structural kind of a Verji space. Mirrors the backend's `CanonicalSpaceKind`, which is
 * closed at these three values.
 */
export enum VerjiSpaceKind {
    TenantRoot = "TenantRoot",
    OrgUnitCategory = "OrgUnitCategory",
    OrgUnit = "OrgUnit",
}

export interface VerjiSpaceContext {
    /** From `app.verji.tenant_info.tenant_id`. Every store read is keyed by this. */
    tenantId: string;
    /** From `app.verji.org_unit_info.org_unit_id`. Present on OrgUnit spaces only. */
    orgUnitId?: string;
    /** Sibling coalesced with parent — the platform-wide pre-split reader rule. Diagnostics. */
    canonicalSpaceId?: string;
    kind: VerjiSpaceKind;
    /**
     * The tenant's display name, for hint interpolation: the name of the tenant's root space, not
     * of the space being rendered. Whether a user may act is decided by their standing in the
     * tenant, so that is the name the hint must give. See {@link resolveVerjiSpaceContext}.
     */
    tenantName: string;
}

/** Synchronous state read. Verji custom events use the event type as their own state key. */
function readContent(space: Room, type: string): Record<string, unknown> | undefined {
    return space.currentState.getStateEvents(type, type)?.getContent();
}

function readString(space: Room, type: string, field: string): string | undefined {
    const value = readContent(space, type)?.[field];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Derive the space's structural kind.
 *
 * The rule is ordered, and the order matters:
 *   1. has `org_unit_info`          ⇒ OrgUnit
 *   2. else no `canonical_parent_space` ⇒ TenantRoot
 *   3. else                          ⇒ OrgUnitCategory
 *
 * **The pre-split fallback lives here and nowhere else.** A personal space of pre-split vintage
 * carries the canonical it mirrors under `canonical_parent_space` rather than
 * `canonical_sibling_space`, so a tenant-root personal space of that vintage *does* have a parent
 * pointer and rule 2 would misread it as an OrgUnitCategory. `isTopLevel` — is this space a root
 * of the client's own space tree? — corrects that. Once the backend propagates
 * `canonical_space_kind` down to personal spaces this whole branch goes away, which is why it is
 * confined to this one function.
 */
export function deriveVerjiSpaceKind(space: Room, isTopLevel: boolean): VerjiSpaceKind {
    if (readString(space, EV_ORG_UNIT_INFO, "org_unit_id")) {
        return VerjiSpaceKind.OrgUnit;
    }
    if (!readString(space, EV_CANONICAL_PARENT_SPACE, "canonical_parent_space_id")) {
        return VerjiSpaceKind.TenantRoot;
    }
    // Pre-split vintage fallback — see the doc comment above. Delete once the kind is propagated.
    if (isTopLevel) {
        return VerjiSpaceKind.TenantRoot;
    }
    return VerjiSpaceKind.OrgUnitCategory;
}

/**
 * Resolve the Verji context of the space being rendered.
 *
 * Returns `null` when the room is not a Verji space at all — no `tenant_info`, or not a space
 * room. Callers must treat `null` as "not a surface this feature governs" and render exactly as
 * today, never as a denial.
 *
 * Neither `tenant_info` nor the access context carries the tenant's name, so it is read off the
 * tenant's root space: the top-level space carrying the same `tenant_id`. If that root is not among
 * the top-level spaces the rendered space's own name stands in, which is only ever true of the root
 * itself.
 *
 * @param space the space room being rendered
 * @param topLevelSpaces the roots of the client's own space tree. They supply the tenant's name, and
 *     whether `space` is one of them feeds the pre-split kind fallback described on
 *     {@link deriveVerjiSpaceKind}
 */
export function resolveVerjiSpaceContext(
    space: Room | null | undefined,
    topLevelSpaces: readonly Room[],
): VerjiSpaceContext | null {
    if (!space || !space.isSpaceRoom()) return null;

    const tenantId = readString(space, EV_TENANT_INFO, "tenant_id");
    if (!tenantId) return null;

    const isTopLevel = topLevelSpaces.some((s) => s.roomId === space.roomId);
    const tenantRoot = isTopLevel
        ? space
        : topLevelSpaces.find((s) => readString(s, EV_TENANT_INFO, "tenant_id") === tenantId);

    return {
        tenantId,
        orgUnitId: readString(space, EV_ORG_UNIT_INFO, "org_unit_id"),
        canonicalSpaceId:
            readString(space, EV_CANONICAL_SIBLING_SPACE, "canonical_sibling_space_id") ??
            readString(space, EV_CANONICAL_PARENT_SPACE, "canonical_parent_space_id"),
        kind: deriveVerjiSpaceKind(space, isTopLevel),
        tenantName: (tenantRoot ?? space).name,
    };
}
