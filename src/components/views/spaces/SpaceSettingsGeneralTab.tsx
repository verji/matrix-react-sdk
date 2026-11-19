/*
Copyright 2021 The Matrix.org Foundation C.I.C.

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

import React, { useEffect, useState } from "react";
import { Room, EventType, MatrixClient, RoomEvent } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { _t } from "../../../languageHandler";
import AccessibleButton from "../elements/AccessibleButton";
import SpaceBasicSettings from "./SpaceBasicSettings";
import { avatarUrlForRoom } from "../../../Avatar";
import { htmlSerializeFromMdIfNeeded } from "../../../editor/serialize";
import { leaveSpace } from "../../../utils/leave-behaviour";
import { getTopic } from "../../../hooks/room/useTopic";
import SettingsTab from "../settings/tabs/SettingsTab";
import { SettingsSection } from "../settings/shared/SettingsSection";
import SettingsSubsection from "../settings/shared/SettingsSubsection";
import SettingsStore from "../../../settings/SettingsStore";
import { UIFeature } from "../../../settings/UIFeature";
// VERJI: a guest org's space is renamed by renaming the guest org (verji/verji-src#2377)
import { useTypedEventEmitter } from "../../../hooks/useEventEmitter";
import { useVerjiGate } from "../../../hooks/useVerjiPermissions";
import SpaceStore from "../../../stores/spaces/SpaceStore";
import { resolveVerjiSpaceContext } from "../../../stores/verji/VerjiSpaceContext";
import { VerjiPermissionsStore } from "../../../stores/verji/VerjiPermissionsStore";
import { getSpaceNameGate, VerjiGateVerdict } from "../../../stores/verji/verjiGates";
import {
    isOrgUnitNameAcceptable,
    MAX_ORG_UNIT_NAME_LENGTH,
    OrgUnitRenameOutcome,
    setOrgUnitNameThroughVerji,
} from "../../../stores/verji/verjiOrgUnitName";

/** VERJI: how long a renamed guest org's space may take to show the name before the note says so. */
export const SLOW_RENAME_MS = 30_000;

/** VERJI: what the user is told when the Organization API refuses a rename. */
function renameRefusal(outcome: OrgUnitRenameOutcome): string | undefined {
    switch (outcome) {
        case OrgUnitRenameOutcome.Invalid:
            return _t("verji|space_name|invalid");
        case OrgUnitRenameOutcome.NoLongerAllowed:
            return _t("verji|space_name|no_longer_allowed");
        case OrgUnitRenameOutcome.RateLimited:
            return _t("verji|space_name|rate_limited");
        default:
            return undefined;
    }
}

interface IProps {
    matrixClient: MatrixClient;
    space: Room;
}

const SpaceSettingsGeneralTab: React.FC<IProps> = ({ matrixClient: cli, space }) => {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const userId = cli.getUserId()!;

    const [newAvatar, setNewAvatar] = useState<File | null | undefined>(null); // undefined means to remove avatar
    const canSetAvatar = space.currentState.maySendStateEvent(EventType.RoomAvatar, userId);
    const avatarChanged = newAvatar !== null;

    const [name, setName] = useState<string>(space.name);
    // VERJI: in a guest org's space, the name gate decides who may rename, and the name is saved by
    // renaming the guest org; Matrix power levels decide only where the gate is NotGated.
    const nameGate = useVerjiGate(space, getSpaceNameGate);
    const nameThroughVerji = nameGate.verdict !== VerjiGateVerdict.NotGated;
    const canSetName = nameThroughVerji
        ? nameGate.verdict === VerjiGateVerdict.Allowed
        : space.currentState.maySendStateEvent(EventType.RoomName, userId);
    const nameChanged = name !== space.name;

    // VERJI: a name the Organization API accepted, until the space shows it; and whether that is taking long.
    const [pendingName, setPendingName] = useState<string | null>(null);
    const [renameSlow, setRenameSlow] = useState(false);
    useTypedEventEmitter(space, RoomEvent.Name, () => {
        if (pendingName !== null && space.name === pendingName) {
            setPendingName(null);
            setName(space.name);
        }
    });
    useEffect(() => {
        if (pendingName === null) return;
        setRenameSlow(false);
        const timer = setTimeout(() => setRenameSlow(true), SLOW_RENAME_MS);
        return () => clearTimeout(timer);
    }, [pendingName]);

    const currentTopic = getTopic(space)?.text ?? "";
    const [topic, setTopic] = useState(currentTopic);
    const canSetTopic = space.currentState.maySendStateEvent(EventType.RoomTopic, userId);
    const topicChanged = topic !== currentTopic;

    const onCancel = (): void => {
        setNewAvatar(null);
        setName(space.name);
        setTopic(currentTopic);
    };

    const onSave = async (): Promise<void> => {
        // VERJI: a name the Organization API would refuse is not sent.
        if (nameChanged && nameThroughVerji && !isOrgUnitNameAcceptable(name)) {
            setError(_t("verji|space_name|invalid"));
            return;
        }

        setBusy(true);
        setError("");
        const promises: Promise<unknown>[] = [];
        let nameRefusal: string | undefined;

        if (avatarChanged) {
            if (newAvatar) {
                promises.push(
                    (async (): Promise<void> => {
                        const { content_uri: url } = await cli.uploadContent(newAvatar);
                        await cli.sendStateEvent(space.roomId, EventType.RoomAvatar, { url }, "");
                    })(),
                );
            } else {
                promises.push(cli.sendStateEvent(space.roomId, EventType.RoomAvatar, {}, ""));
            }
        }

        if (nameChanged && nameThroughVerji) {
            // VERJI: the gate allows only in an OrgUnit space, which always has its OrgUnit's id.
            const ctx = resolveVerjiSpaceContext(space, SpaceStore.instance.spacePanelSpaces);
            promises.push(
                (async (): Promise<void> => {
                    if (!ctx?.orgUnitId) throw new Error("No OrgUnit for this space");
                    const outcome = await setOrgUnitNameThroughVerji(cli, ctx.tenantId, ctx.orgUnitId, name);
                    if (outcome === OrgUnitRenameOutcome.Accepted) {
                        setPendingName(name.trim());
                        return;
                    }
                    if (outcome === OrgUnitRenameOutcome.NoLongerAllowed) {
                        VerjiPermissionsStore.instance.refreshTenant(ctx.tenantId);
                    }
                    nameRefusal = renameRefusal(outcome);
                    throw new Error(`Renaming the guest org: ${outcome}`);
                })(),
            );
        } else if (nameChanged) {
            promises.push(cli.setRoomName(space.roomId, name));
        }

        if (topicChanged) {
            const htmlTopic = htmlSerializeFromMdIfNeeded(topic, { forceHTML: false });
            promises.push(cli.setRoomTopic(space.roomId, topic, htmlTopic));
        }

        const results = await Promise.allSettled(promises);
        setBusy(false);
        const failures = results.filter((r) => r.status === "rejected");
        if (failures.length > 0) {
            logger.error("Failed to save space settings: ", failures);
            // VERJI: say why a rename was refused, unless something else failed too.
            setError(
                nameRefusal && failures.length === 1
                    ? nameRefusal
                    : _t("room_settings|general|error_save_space_settings"),
            );
        }
    };

    return (
        <SettingsTab>
            <SettingsSection heading={_t("common|general")}>
                <div>
                    <div>{_t("room_settings|general|description_space")}</div>

                    {error && <div className="mx_SpaceRoomView_errorText">{error}</div>}

                    <SpaceBasicSettings
                        avatarUrl={avatarUrlForRoom(space, 80, 80, "crop") ?? undefined}
                        avatarDisabled={busy || !canSetAvatar}
                        setAvatar={setNewAvatar}
                        name={name}
                        nameDisabled={busy || !canSetName || pendingName !== null}
                        nameMaxLength={nameThroughVerji ? MAX_ORG_UNIT_NAME_LENGTH : undefined}
                        setName={setName}
                        topic={topic}
                        topicDisabled={busy || !canSetTopic}
                        setTopic={setTopic}
                    />

                    {/* VERJI: why the name cannot be changed here, and how a rename is getting on */}
                    {nameThroughVerji && nameGate.hint && (
                        <div className="mx_SpaceSettingsGeneralTab_verjiNameHint">{nameGate.hint}</div>
                    )}
                    {pendingName !== null && (
                        <div className="mx_SpaceSettingsGeneralTab_verjiNamePending" role="status">
                            {renameSlow ? _t("verji|space_name|slow") : _t("verji|space_name|saved_pending")}
                        </div>
                    )}

                    <AccessibleButton
                        onClick={onCancel}
                        disabled={busy || pendingName !== null || !(avatarChanged || nameChanged || topicChanged)}
                        kind="link"
                    >
                        {_t("action|cancel")}
                    </AccessibleButton>
                    <AccessibleButton onClick={onSave} disabled={busy || pendingName !== null} kind="primary">
                        {busy ? _t("common|saving") : _t("room_settings|general|save")}
                    </AccessibleButton>
                </div>
                {SettingsStore.getValue(UIFeature.LeaveSpaceButton) && (
                    <SettingsSubsection heading={_t("room_settings|general|leave_space")}>
                        <AccessibleButton
                            kind="danger"
                            onClick={() => {
                                leaveSpace(space);
                            }}
                        >
                            {_t("room_settings|general|leave_space")}
                        </AccessibleButton>
                    </SettingsSubsection>
                )}
            </SettingsSection>
        </SettingsTab>
    );
};

export default SpaceSettingsGeneralTab;
