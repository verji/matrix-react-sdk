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

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MatrixClient, Room } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import type { OrgUnitRoomCandidate } from "@verji/verji-api-sdk";
import { _t } from "../../../../languageHandler";
import Modal from "../../../../Modal";
import BaseDialog from "../BaseDialog";
import SearchBox from "../../../structures/SearchBox";
import AutoHideScrollbar from "../../../structures/AutoHideScrollbar";
import AccessibleButton from "../../elements/AccessibleButton";
import Spinner from "../../elements/Spinner";
import BaseAvatar from "../../avatars/BaseAvatar";
import DecoratedRoomAvatar from "../../avatars/DecoratedRoomAvatar";
import SpaceStore from "../../../../stores/spaces/SpaceStore";
import { resolveVerjiSpaceContext } from "../../../../stores/verji/VerjiSpaceContext";
import {
    assignRoomToOrgUnit,
    getConflictReason,
    getOrgUnitRoomCandidates,
    describeError,
} from "../../../../stores/verji/verjiOrgUnitRooms";

/**
 * VERJI: "Add existing room" on a guest org's space (verji/verji-src#2117).
 *
 * Lists the rooms the tenant's PrimaryContact is in that the Organization API says could be
 * assigned to the guest org, and assigns the chosen ones through it, one at a time. The upstream
 * `AddExistingToSpace` picker is not used: it lists the client's own rooms and commits by writing
 * `m.space.child` itself, while here the server decides which rooms fit and does the assigning.
 *
 * Suggested rooms come first; rooms of the tenant's people only are behind "Show all rooms";
 * refused rooms are listed last, disabled, with why. A refused room has someone from outside the
 * guest org in it, so its row shows nothing taken from its members: not the name matrix-js-sdk
 * makes up from them for a room that has none, nor their avatar.
 */

interface IProps {
    client: MatrixClient;
    tenantId: string;
    tenantName: string;
    orgUnitId: string;
    orgUnitName: string;
    onFinished(added?: boolean): void;
}

interface Names {
    tenant: string;
    orgUnit: string;
}

/** A readable message for a 409's reason. */
export function describeOrgUnitRoomConflict(reason: string | undefined, names: Names): string {
    switch (reason) {
        case "MemberOutsideOrgUnit":
            return _t("verji|add_existing|refused_member_outside", { orgUnit: names.orgUnit, tenant: names.tenant });
        case "NotARoom":
            return _t("verji|add_existing|refused_not_a_room");
        case "NotInTenant":
            return _t("verji|add_existing|refused_not_in_tenant", { tenant: names.tenant });
        case "AlreadyInOrgUnit":
            return _t("verji|add_existing|refused_already_in_org_unit");
        case "CallerNotInRoom":
            return _t("verji|add_existing|refused_caller_not_in_room");
        case "NotPrivate":
            return _t("verji|add_existing|refused_not_private");
        case "RoomUnreadable":
            return _t("verji|add_existing|refused_room_unreadable");
        case "OrgUnitHasNoSpace":
            return _t("verji|add_existing|refused_no_space", { orgUnit: names.orgUnit });
        default:
            return _t("verji|add_existing|room_failed");
    }
}

/**
 * The 409 reasons that hold whatever the client does next: a room refused for one of them stays
 * disabled. Any other reason, known or not, may pass, so the room can be tried again.
 */
const PERMANENT_REFUSALS: ReadonlySet<string> = new Set([
    "MemberOutsideOrgUnit",
    "NotARoom",
    "NotInTenant",
    "AlreadyInOrgUnit",
    "CallerNotInRoom",
    "NotPrivate",
]);

const isPermanentRefusal = (reason: string | null | undefined): reason is string =>
    !!reason && PERMANENT_REFUSALS.has(reason);

type RowState =
    | { kind: "idle" }
    | { kind: "busy" }
    | { kind: "added" }
    // Refused for good: disabled.
    | { kind: "refused"; message: string }
    // Refused for now, or for a reason the client does not know: can be tried again.
    | { kind: "failed"; message: string };

const AddExistingRoomToOrgUnitDialog: React.FC<IProps> = ({
    client,
    tenantId,
    tenantName,
    orgUnitId,
    orgUnitName,
    onFinished,
}) => {
    const names = useMemo(() => ({ tenant: tenantName, orgUnit: orgUnitName }), [tenantName, orgUnitName]);
    const [candidates, setCandidates] = useState<OrgUnitRoomCandidate[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [showAll, setShowAll] = useState(false);
    const [query, setQuery] = useState("");
    const [rows, setRows] = useState<Record<string, RowState>>({});
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
        setLoadError(null);
        setCandidates(null);
        try {
            const list = await getOrgUnitRoomCandidates(client, tenantId, orgUnitId);
            if (!mounted.current) return;
            setCandidates(list);
        } catch (e) {
            const reason = getConflictReason(e);
            if (reason === null)
                logger.error("[Verji.OrgUnitRooms] Failed to list the room candidates", describeError(e));
            if (!mounted.current) return;
            // The list's one refusal the client can explain; anything else is a list that did not load.
            setLoadError(
                reason === "OrgUnitHasNoSpace"
                    ? describeOrgUnitRoomConflict(reason, names)
                    : _t("verji|add_existing|load_failed"),
            );
        }
    }, [client, tenantId, orgUnitId, names]);

    useEffect(() => {
        void load();
    }, [load]);

    const busy = Object.values(rows).some((row) => row.kind === "busy");
    const addedAny = Object.values(rows).some((row) => row.kind === "added");

    const onAdd = async (candidate: OrgUnitRoomCandidate): Promise<void> => {
        setError(null);
        setRows((r) => ({ ...r, [candidate.roomId]: { kind: "busy" } }));
        try {
            await assignRoomToOrgUnit(client, tenantId, orgUnitId, candidate.roomId);
            if (!mounted.current) return;
            setRows((r) => ({ ...r, [candidate.roomId]: { kind: "added" } }));
        } catch (e) {
            const reason = getConflictReason(e);
            if (reason === null) {
                logger.error("[Verji.OrgUnitRooms] Failed to assign the room", candidate.roomId, describeError(e));
                if (!mounted.current) return;
                setError(_t("verji|add_existing|room_failed"));
                setRows((r) => ({ ...r, [candidate.roomId]: { kind: "idle" } }));
                return;
            }
            if (!mounted.current) return;
            // The server's answer for this room, shown on its row: disabled for a permanent refusal,
            // left to be tried again for any other.
            const message = describeOrgUnitRoomConflict(reason, names);
            const kind = isPermanentRefusal(reason) ? "refused" : "failed";
            setRows((r) => ({ ...r, [candidate.roomId]: { kind, message } }));
        }
    };

    /**
     * The row's name, which the search matches too. A refused room never takes the name
     * matrix-js-sdk computes from its members, which would name someone from outside the guest org.
     */
    const label = (candidate: OrgUnitRoomCandidate): string =>
        candidate.fit === "Refused"
            ? candidate.name || _t("verji|add_existing|unnamed_room")
            : candidate.name || client.getRoom(candidate.roomId)?.name || candidate.roomId;

    const lcQuery = query.toLowerCase().trim();
    const matching = (candidates ?? []).filter((c) => !lcQuery || label(c).toLowerCase().includes(lcQuery));
    const suggested = matching.filter((c) => c.fit === "Suggested");
    const internal = matching.filter((c) => c.fit === "Internal");
    // A fit the client does not know yet is not offered: the server would refuse it or the client
    // would misread it.
    const refused = matching.filter((c) => c.fit === "Refused");

    const renderRow = (candidate: OrgUnitRoomCandidate): JSX.Element => {
        const room: Room | null = client.getRoom(candidate.roomId);
        const row = rows[candidate.roomId] ?? { kind: "idle" };
        const isRefused = candidate.fit === "Refused";
        const name = label(candidate);
        // A refused room's reason, or what its fit means when the reason is missing or not one the
        // client knows: someone in it is from outside the guest org.
        const hint = isRefused
            ? describeOrgUnitRoomConflict(
                  isPermanentRefusal(candidate.reason) ? candidate.reason : "MemberOutsideOrgUnit",
                  names,
              )
            : row.kind === "refused" || row.kind === "failed"
              ? row.message
              : undefined;
        let avatar: JSX.Element | null = null;
        if (isRefused) avatar = <BaseAvatar name={name} idName={candidate.roomId} size="32px" />;
        else if (room) avatar = <DecoratedRoomAvatar room={room} size="32px" />;
        return (
            <div
                key={candidate.roomId}
                className="mx_AddExistingToSpace_entry mx_VerjiAddExistingToOrgUnit_entry"
                data-testid={`verji-room-candidate-${candidate.roomId}`}
            >
                {avatar}
                <span className="mx_AddExistingToSpace_entry_name">
                    {name}
                    {hint && <div className="mx_VerjiAddExistingToOrgUnit_hint">{hint}</div>}
                </span>
                <AccessibleButton
                    kind="primary_outline"
                    className="mx_VerjiAddExistingToOrgUnit_add"
                    disabled={isRefused || busy || (row.kind !== "idle" && row.kind !== "failed")}
                    onClick={() => void onAdd(candidate)}
                >
                    {row.kind === "added" ? _t("verji|add_existing|added") : _t("action|add")}
                </AccessibleButton>
            </div>
        );
    };

    const section = (testId: string, title: string, list: OrgUnitRoomCandidate[]): JSX.Element | null =>
        list.length === 0 ? null : (
            <div className="mx_AddExistingToSpace_section" data-testid={testId}>
                <h3>{title}</h3>
                {list.map(renderRow)}
            </div>
        );

    let body: JSX.Element;
    if (loadError) {
        body = (
            <div className="mx_VerjiAddExistingToOrgUnit_message">
                <div>{loadError}</div>
                <AccessibleButton kind="link" onClick={() => void load()}>
                    {_t("action|retry")}
                </AccessibleButton>
            </div>
        );
    } else if (!candidates) {
        body = <Spinner />;
    } else {
        const nothingShown = suggested.length === 0 && (!showAll || internal.length === 0) && refused.length === 0;
        // Without a search, rooms behind "Show all rooms" are not "no results": the link is the way on.
        let empty: string | null = null;
        if (nothingShown && lcQuery) {
            empty = _t("common|no_results");
        } else if (nothingShown && internal.length === 0) {
            empty = _t("verji|add_existing|no_rooms", { orgUnit: orgUnitName });
        }
        body = (
            <>
                {section("verji-room-candidates-suggested", _t("verji|add_existing|section_suggested"), suggested)}
                {showAll &&
                    section(
                        "verji-room-candidates-internal",
                        _t("verji|add_existing|section_internal", { tenant: tenantName }),
                        internal,
                    )}
                {!showAll && internal.length > 0 && (
                    <div className="mx_AddExistingToSpace_section">
                        <AccessibleButton kind="link" onClick={() => setShowAll(true)}>
                            {_t("verji|add_existing|show_all_rooms")}
                        </AccessibleButton>
                    </div>
                )}
                {section("verji-room-candidates-refused", _t("verji|add_existing|section_refused"), refused)}
                {empty && <span className="mx_AddExistingToSpace_noResults">{empty}</span>}
            </>
        );
    }

    return (
        <BaseDialog
            title={_t("verji|add_existing|room_title", { orgUnit: orgUnitName })}
            className="mx_AddExistingToSpaceDialog mx_VerjiAddExistingToOrgUnitDialog"
            contentId="mx_VerjiAddExistingToOrgUnit"
            onFinished={() => onFinished(addedAny)}
            fixedWidth={false}
        >
            <div className="mx_AddExistingToSpace" id="mx_VerjiAddExistingToOrgUnit">
                <div className="mx_VerjiAddExistingToOrgUnit_description">
                    {_t("verji|add_existing|room_description", { orgUnit: orgUnitName })}
                </div>
                <SearchBox
                    className="mx_textinput_icon mx_textinput_search"
                    placeholder={_t("verji|add_existing|room_filter")}
                    onSearch={setQuery}
                    autoFocus={true}
                />
                <AutoHideScrollbar className="mx_AddExistingToSpace_content">{body}</AutoHideScrollbar>
                <div className="mx_AddExistingToSpace_footer">
                    <span role="status" className="mx_VerjiAddExistingToOrgUnit_error">
                        {error}
                    </span>
                    <AccessibleButton kind="primary" disabled={busy} onClick={() => onFinished(addedAny)}>
                        {_t("action|done")}
                    </AccessibleButton>
                </div>
            </div>
        </BaseDialog>
    );
};

export default AddExistingRoomToOrgUnitDialog;

/**
 * Open "Add existing room" for a guest org's space. Does nothing for a space that is not a Verji
 * OrgUnit space, which the menu never offers it on.
 */
export function showAddExistingRoomToOrgUnitDialog(space: Room): void {
    const ctx = resolveVerjiSpaceContext(space, SpaceStore.instance.spacePanelSpaces);
    if (!ctx?.orgUnitId) return;
    Modal.createDialog(
        AddExistingRoomToOrgUnitDialog,
        {
            client: space.client,
            tenantId: ctx.tenantId,
            tenantName: ctx.tenantName,
            orgUnitId: ctx.orgUnitId,
            orgUnitName: space.name,
        },
        "mx_AddExistingToSpaceDialog_wrapper",
    );
}
