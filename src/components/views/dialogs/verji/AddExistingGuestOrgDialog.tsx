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

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ClientEvent, MatrixClient, Room, RoomEvent, RoomStateEvent } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import type { OrgUnit } from "@verji/verji-api-sdk";
import { _t } from "../../../../languageHandler";
import Modal from "../../../../Modal";
import BaseDialog from "../BaseDialog";
import SearchBox from "../../../structures/SearchBox";
import AutoHideScrollbar from "../../../structures/AutoHideScrollbar";
import AccessibleButton from "../../elements/AccessibleButton";
import Spinner from "../../elements/Spinner";
import SpaceStore from "../../../../stores/spaces/SpaceStore";
import { VerjiPermissionsStore } from "../../../../stores/verji/VerjiPermissionsStore";
import { resolveVerjiSpaceContext } from "../../../../stores/verji/VerjiSpaceContext";
import {
    assignDefaultOrgUnitCategory,
    findOrgUnitSpace,
    getOrgUnitsWithoutCategory,
    describeError,
} from "../../../../stores/verji/verjiOrgUnitRooms";
import { showAddExistingRoomToOrgUnitDialog } from "./AddExistingRoomToOrgUnitDialog";

/**
 * VERJI: "Add existing Guest Organization" on the Guest Organizations space and on the tenant's
 * root space (verji/verji-src#2117).
 *
 * Lists the tenant's guest orgs from before Hierarchy V2 — the org units with no category — that
 * the user may bring in: every one for the tenant's PrimaryContact, their own for a guest org's
 * Owner. Brings the chosen one in through the Organization API, which gives it the tenant's default
 * category; its space and its people's personal spaces follow asynchronously. The dialog then
 * waits for the user's own space of the guest org to arrive and offers "Add existing room" for it,
 * since a guest org brought in shows its people an empty space until its rooms are assigned.
 */

interface IProps {
    client: MatrixClient;
    tenantId: string;
    tenantName: string;
    onFinished(): void;
}

type Phase =
    | { kind: "pick" }
    | { kind: "sending"; orgUnit: OrgUnit }
    | { kind: "waiting"; orgUnit: OrgUnit }
    | { kind: "ready"; orgUnit: OrgUnit; space: Room };

/**
 * The client's space for the org unit, once it has one, re-read whenever a room or room state
 * arrives. Null while there is none, or while `orgUnitId` is undefined.
 */
function useOrgUnitSpace(client: MatrixClient, tenantId: string, orgUnitId: string | undefined): Room | null {
    const [space, setSpace] = useState<Room | null>(null);

    useEffect(() => {
        if (!orgUnitId) {
            setSpace(null);
            return;
        }
        const check = (): void => setSpace(findOrgUnitSpace(client, tenantId, orgUnitId));
        check();
        client.on(ClientEvent.Room, check);
        client.on(RoomEvent.MyMembership, check);
        client.on(RoomStateEvent.Events, check);
        return () => {
            client.off(ClientEvent.Room, check);
            client.off(RoomEvent.MyMembership, check);
            client.off(RoomStateEvent.Events, check);
        };
    }, [client, tenantId, orgUnitId]);

    return space;
}

const AddExistingGuestOrgDialog: React.FC<IProps> = ({ client, tenantId, tenantName, onFinished }) => {
    const [orgUnits, setOrgUnits] = useState<OrgUnit[] | null>(null);
    const [loadError, setLoadError] = useState(false);
    const [query, setQuery] = useState("");
    const [phase, setPhase] = useState<Phase>({ kind: "pick" });
    const [error, setError] = useState<string | null>(null);
    // An answer that arrives after the dialog closed changes nothing. A layout effect, so the flag
    // is down as the dialog unmounts rather than when React gets round to its passive cleanups.
    const mounted = useRef(true);
    useLayoutEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    const load = useCallback(async (): Promise<void> => {
        setLoadError(false);
        setOrgUnits(null);
        try {
            const list = await getOrgUnitsWithoutCategory(client, tenantId, VerjiPermissionsStore.instance);
            if (!mounted.current) return;
            setOrgUnits([...list].sort((a, b) => a.name.localeCompare(b.name)));
        } catch (e) {
            logger.error("[Verji.OrgUnitRooms] Failed to list the org units", describeError(e));
            if (!mounted.current) return;
            setLoadError(true);
        }
    }, [client, tenantId]);

    useEffect(() => {
        void load();
    }, [load]);

    const waitingFor = phase.kind === "waiting" ? phase.orgUnit : undefined;
    const arrived = useOrgUnitSpace(client, tenantId, waitingFor?.id);
    useEffect(() => {
        if (waitingFor && arrived) setPhase({ kind: "ready", orgUnit: waitingFor, space: arrived });
    }, [waitingFor, arrived]);

    const onAdd = async (orgUnit: OrgUnit): Promise<void> => {
        setError(null);
        setPhase({ kind: "sending", orgUnit });
        try {
            await assignDefaultOrgUnitCategory(client, tenantId, orgUnit.id);
            if (!mounted.current) return;
            setPhase({ kind: "waiting", orgUnit });
        } catch (e) {
            logger.error("[Verji.OrgUnitRooms] Failed to bring the org unit in", orgUnit.id, describeError(e));
            if (!mounted.current) return;
            setError(_t("verji|add_existing|guest_org_failed", { orgUnit: orgUnit.name }));
            setPhase({ kind: "pick" });
        }
    };

    const onAddRooms = (space: Room): void => {
        onFinished();
        showAddExistingRoomToOrgUnitDialog(space);
    };

    let content: JSX.Element;
    if (phase.kind === "waiting") {
        content = (
            <div className="mx_VerjiAddExistingToOrgUnit_message" data-testid="verji-guest-org-waiting">
                <Spinner />
                <div>{_t("verji|add_existing|guest_org_waiting", { orgUnit: phase.orgUnit.name })}</div>
                <div className="mx_AddExistingToSpace_footer">
                    <span />
                    <AccessibleButton kind="secondary" onClick={onFinished}>
                        {_t("action|close")}
                    </AccessibleButton>
                </div>
            </div>
        );
    } else if (phase.kind === "ready") {
        content = (
            <div className="mx_VerjiAddExistingToOrgUnit_message" data-testid="verji-guest-org-ready">
                <div>{_t("verji|add_existing|guest_org_ready", { orgUnit: phase.orgUnit.name })}</div>
                <div className="mx_AddExistingToSpace_footer">
                    <span />
                    <AccessibleButton kind="secondary" onClick={onFinished}>
                        {_t("verji|add_existing|later")}
                    </AccessibleButton>
                    <AccessibleButton kind="primary" onClick={() => onAddRooms(phase.space)}>
                        {_t("verji|add_existing|add_rooms")}
                    </AccessibleButton>
                </div>
            </div>
        );
    } else {
        const lcQuery = query.toLowerCase().trim();
        const matching = (orgUnits ?? []).filter((u) => !lcQuery || u.name.toLowerCase().includes(lcQuery));
        let list: JSX.Element;
        if (loadError) {
            list = (
                <div className="mx_VerjiAddExistingToOrgUnit_message">
                    <div>{_t("verji|add_existing|load_failed")}</div>
                    <AccessibleButton kind="link" onClick={() => void load()}>
                        {_t("action|retry")}
                    </AccessibleButton>
                </div>
            );
        } else if (!orgUnits) {
            list = <Spinner />;
        } else if (matching.length === 0) {
            list = (
                <span className="mx_AddExistingToSpace_noResults">
                    {lcQuery ? _t("common|no_results") : _t("verji|add_existing|guest_org_none")}
                </span>
            );
        } else {
            list = (
                <div className="mx_AddExistingToSpace_section">
                    {matching.map((orgUnit) => (
                        <div
                            key={orgUnit.id}
                            className="mx_AddExistingToSpace_entry mx_VerjiAddExistingToOrgUnit_entry"
                            data-testid={`verji-guest-org-${orgUnit.id}`}
                        >
                            <span className="mx_AddExistingToSpace_entry_name">{orgUnit.name}</span>
                            <AccessibleButton
                                kind="primary_outline"
                                className="mx_VerjiAddExistingToOrgUnit_add"
                                disabled={phase.kind === "sending"}
                                onClick={() => void onAdd(orgUnit)}
                            >
                                {_t("action|add")}
                            </AccessibleButton>
                        </div>
                    ))}
                </div>
            );
        }
        content = (
            <>
                <div className="mx_VerjiAddExistingToOrgUnit_description">
                    {_t("verji|add_existing|guest_org_description", { tenant: tenantName })}
                </div>
                <SearchBox
                    className="mx_textinput_icon mx_textinput_search"
                    placeholder={_t("verji|add_existing|guest_org_filter")}
                    onSearch={setQuery}
                    autoFocus={true}
                />
                <AutoHideScrollbar className="mx_AddExistingToSpace_content">{list}</AutoHideScrollbar>
                <div className="mx_AddExistingToSpace_footer">
                    <span role="status" className="mx_VerjiAddExistingToOrgUnit_error">
                        {error}
                    </span>
                    <AccessibleButton kind="secondary" onClick={onFinished}>
                        {_t("action|cancel")}
                    </AccessibleButton>
                </div>
            </>
        );
    }

    return (
        <BaseDialog
            title={_t("verji|add_existing|guest_org_title")}
            className="mx_AddExistingToSpaceDialog mx_VerjiAddExistingToOrgUnitDialog"
            contentId="mx_VerjiAddExistingGuestOrg"
            onFinished={onFinished}
            fixedWidth={false}
        >
            <div className="mx_AddExistingToSpace" id="mx_VerjiAddExistingGuestOrg">
                {content}
            </div>
        </BaseDialog>
    );
};

export default AddExistingGuestOrgDialog;

/**
 * Open "Add existing Guest Organization" for a category space or the tenant's root space. Does
 * nothing for a room that is not a Verji space, which the menu never offers it on.
 */
export function showAddExistingGuestOrgDialog(space: Room): void {
    const ctx = resolveVerjiSpaceContext(space, SpaceStore.instance.spacePanelSpaces);
    if (!ctx) return;
    Modal.createDialog(
        AddExistingGuestOrgDialog,
        { client: space.client, tenantId: ctx.tenantId, tenantName: ctx.tenantName },
        "mx_AddExistingToSpaceDialog_wrapper",
    );
}
