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

import { _t } from "../../languageHandler";
import { VerjiSpaceContext, VerjiSpaceKind } from "./VerjiSpaceContext";
import { isOrgUnitMember, isOrgUnitOwner, isStandardUser, isTenantPrimaryContact, VerjiRoleReader } from "./verjiRoles";

/**
 * VERJI: the Hierarchy V2 gate decisions.
 *
 * # The two fail directions are deliberately opposite
 *
 * **The rollout switch fails to today's behaviour.** If `canonicalSpaceSyncEnabled` is false for
 * the tenant — or the tenant has no cached record at all, which is the same thing as far as the
 * client can tell — the whole per-user gating layer is off and every affordance renders exactly as
 * it ships today: enabled, no hint, no disabled state. Not "deny", not "checking". This is a hard
 * product requirement: a gate that ignores the switch silently restricts production users who were
 * never meant to be in the beta.
 *
 * **The permission check, once gating is on, fails to deny.** With a record in hand we know both
 * that the tenant is in the beta and what the user's roles are, so an unknown role reads as denied
 * and the affordance renders disabled with an explanatory hint. Showing an affordance that will
 * 403 on click is worse than showing it disabled.
 *
 * Inverting either is a serious bug, so both live here, behind {@link evaluateGate}, which is the
 * single short-circuit every gate in this file passes through. Add a fifth surface and it inherits
 * the switch for free; that is the point of the shape.
 */

export enum VerjiGateVerdict {
    /** The rollout switch is off for this tenant. Render exactly as today — do not disable. */
    NotGated = "not-gated",
    /** Gating is on and the user may act. */
    Allowed = "allowed",
    /** Gating is on and the user may not act. Render disabled with {@link VerjiGateDecision.hint}. */
    Denied = "denied",
    /** Gating is on and the affordance is removed for everyone at this surface. */
    Hidden = "hidden",
}

export interface VerjiGateDecision {
    verdict: VerjiGateVerdict;
    /** Hover hint, present only when the verdict is {@link VerjiGateVerdict.Denied}. */
    hint?: string;
}

const NOT_GATED: VerjiGateDecision = { verdict: VerjiGateVerdict.NotGated };
const ALLOWED: VerjiGateDecision = { verdict: VerjiGateVerdict.Allowed };
const HIDDEN: VerjiGateDecision = { verdict: VerjiGateVerdict.Hidden };

const denied = (hint: string): VerjiGateDecision => ({ verdict: VerjiGateVerdict.Denied, hint });

/** The store slice a gate needs: the rollout switch plus role reads. */
export interface VerjiGateReader extends VerjiRoleReader {
    isCanonicalSpaceSyncEnabled(tenantId: string): boolean;
}

/**
 * The single short-circuit. Resolves "is this tenant in the beta at all?" before any permission is
 * consulted, so no gate can accidentally restrict a tenant outside the rollout.
 *
 * `ctx` is null when the rendered room is not a Verji space (no `tenant_info`) — not a surface
 * this feature governs, so also today's behaviour.
 */
function evaluateGate(
    ctx: VerjiSpaceContext | null,
    reader: VerjiGateReader,
    evaluate: (ctx: VerjiSpaceContext) => VerjiGateDecision,
): VerjiGateDecision {
    if (!ctx) return NOT_GATED;
    if (!reader.isCanonicalSpaceSyncEnabled(ctx.tenantId)) return NOT_GATED;
    return evaluate(ctx);
}

/**
 * Onboarding a user to the tenant, behind the People sublist's "Persons+" button.
 *
 * Enabled for a StandardUser of the tenant; disabled with a hint for a Guest. The button follows
 * the active tenant context rather than depth, so the space's kind is not consulted.
 */
export function getOnboardToTenantGate(ctx: VerjiSpaceContext | null, reader: VerjiGateReader): VerjiGateDecision {
    return evaluateGate(ctx, reader, (c) => {
        if (isStandardUser(reader, c.tenantId)) return ALLOWED;
        return denied(_t("verji|gate|onboard_denied_guest", { tenant: c.tenantName }));
    });
}

/**
 * Creating a room, behind the Rooms sublist "+".
 *
 * - TenantRoot: StandardUser only.
 * - OrgUnitCategory: removed for everyone. Rooms do not belong directly to a category.
 * - OrgUnit: StandardUser **and** (Member **or** Owner) of that OrgUnit.
 *
 * The awkward case falls out for free: a user who holds the mirrored room structure
 * without OrgUnit membership reads `org_unit_id` off the space, finds it in none of their instance
 * lists, and is denied. No special case.
 */
export function getCreateRoomGate(ctx: VerjiSpaceContext | null, reader: VerjiGateReader): VerjiGateDecision {
    return evaluateGate(ctx, reader, (c) => {
        switch (c.kind) {
            case VerjiSpaceKind.OrgUnitCategory:
                return HIDDEN;

            case VerjiSpaceKind.OrgUnit: {
                // Two distinct denial reasons, and the hint must name the right one.
                if (!isStandardUser(reader, c.tenantId)) {
                    return denied(_t("verji|gate|create_room_denied_guest", { tenant: c.tenantName }));
                }
                if (!c.orgUnitId) {
                    // An OrgUnit space is identified *by* org_unit_info, so this is unreachable via
                    // resolveVerjiSpaceContext. Kept because the fail-closed direction is the safe
                    // one if the kind is ever derived some other way.
                    return denied(_t("verji|gate|create_room_denied_not_org_member"));
                }
                const inOrgUnit =
                    isOrgUnitMember(reader, c.tenantId, c.orgUnitId) || isOrgUnitOwner(reader, c.tenantId, c.orgUnitId);
                return inOrgUnit ? ALLOWED : denied(_t("verji|gate|create_room_denied_not_org_member"));
            }

            case VerjiSpaceKind.TenantRoot:
            default:
                if (isStandardUser(reader, c.tenantId)) return ALLOWED;
                return denied(_t("verji|gate|create_room_denied_guest", { tenant: c.tenantName }));
        }
    });
}

/**
 * The space settings entry.
 *
 * Specified here so the decision model is complete and testable, but **not yet wired to a
 * surface**. It waits on vsys-mediated avatar propagation across a canonical's personal spaces,
 * which has no design yet; enabling the settings entry before that would show a door that opens
 * onto nothing — personal spaces set `m.room.avatar` at PL 50 while users sit at -10.
 */
export function getSpaceSettingsGate(ctx: VerjiSpaceContext | null, reader: VerjiGateReader): VerjiGateDecision {
    return evaluateGate(ctx, reader, (c) => {
        if (c.kind === VerjiSpaceKind.OrgUnit) {
            if (!isStandardUser(reader, c.tenantId) || !c.orgUnitId) {
                return denied(_t("verji|gate|settings_denied_not_org_member_or_owner"));
            }
            const inOrgUnit =
                isOrgUnitMember(reader, c.tenantId, c.orgUnitId) || isOrgUnitOwner(reader, c.tenantId, c.orgUnitId);
            return inOrgUnit ? ALLOWED : denied(_t("verji|gate|settings_denied_not_org_member_or_owner"));
        }
        if (isTenantPrimaryContact(reader, c.tenantId)) return ALLOWED;
        return denied(_t("verji|gate|settings_denied_not_primary_contact", { tenant: c.tenantName }));
    });
}

/** Should the affordance render at all? False only for {@link VerjiGateVerdict.Hidden}. */
export function isGateVisible(decision: VerjiGateDecision): boolean {
    return decision.verdict !== VerjiGateVerdict.Hidden;
}

/**
 * Should the affordance render disabled?
 *
 * Note that `NotGated` is **not** disabled — that is the whole point of the rollout switch.
 */
export function isGateDisabled(decision: VerjiGateDecision): boolean {
    return decision.verdict === VerjiGateVerdict.Denied;
}
