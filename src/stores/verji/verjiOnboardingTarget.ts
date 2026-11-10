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

import SettingsStore from "../../settings/SettingsStore";
import { UIFeature } from "../../settings/UIFeature";
import SpaceStore from "../spaces/SpaceStore";
import { VerjiPermissionsStore } from "./VerjiPermissionsStore";
import { resolveVerjiSpaceContext, VerjiSpaceKind } from "./VerjiSpaceContext";
import { getOnboardGate, getOnboardToTenantGate, VerjiGateDecision } from "./verjiGates";

/** Re-exported so the module reads a decision the way the button does, through this one import. */
export { isGateDisabled } from "./verjiGates";

/**
 * VERJI: where Persons+ onboards people to, for the onboarding module's invite dialog
 * (verji/verji-src#2177).
 *
 * The module asks this one function instead of reading room state, roles or settings itself, so
 * the decision it acts on is exactly the one the Persons+ button was rendered from, and the role
 * names stay in `verjiRoles`.
 */
export interface VerjiOnboardingTarget {
    /** The tenant people are onboarded to. */
    tenantId: string;
    /** The tenant's display name. */
    tenantName: string;
    /**
     * The guest org every invited person joins, when Persons+ is pressed in a guest org's space and
     * onboarding into a guest org is switched on. Absent: each gets a new guest org of their own.
     */
    guestOrganizationId?: string;
    /** That guest org's name, from the space's `org_unit_info`, for the dialog's text. */
    guestOrganizationName?: string;
    /** The Persons+ gate's decision for the space. The dialog refuses what the button would. */
    decision: VerjiGateDecision;
}

/** Is onboarding into a guest org switched on for this deployment? */
export function isVerjiGuestOrgOnboardingEnabled(): boolean {
    return SettingsStore.getValue(UIFeature.VerjiGuestOrgOnboarding);
}

/**
 * Where Persons+ in `space` onboards people to, or null when `space` is not a Verji space (the
 * dialog then behaves as it always has).
 *
 * @param space the space the invite dialog was opened from: the active space, as for the button
 */
export function resolveVerjiOnboardingTarget(space: Room | null | undefined): VerjiOnboardingTarget | null {
    const ctx = resolveVerjiSpaceContext(space, SpaceStore.instance.spacePanelSpaces);
    if (!ctx) return null;

    const reader = VerjiPermissionsStore.instance;
    if (!isVerjiGuestOrgOnboardingEnabled()) {
        return { tenantId: ctx.tenantId, tenantName: ctx.tenantName, decision: getOnboardToTenantGate(ctx, reader) };
    }

    const intoGuestOrg = ctx.kind === VerjiSpaceKind.OrgUnit && !!ctx.orgUnitId;
    return {
        tenantId: ctx.tenantId,
        tenantName: ctx.tenantName,
        guestOrganizationId: intoGuestOrg ? ctx.orgUnitId : undefined,
        guestOrganizationName: intoGuestOrg ? ctx.orgUnitName ?? space?.name : undefined,
        decision: getOnboardGate(ctx, reader),
    };
}
