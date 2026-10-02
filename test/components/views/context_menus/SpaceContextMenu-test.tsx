/*
Copyright 2022 The Matrix.org Foundation C.I.C.

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

import React from "react";
import { MatrixClient, Room } from "matrix-js-sdk/src/matrix";
import { Mocked, mocked } from "jest-mock";
import { act, prettyDOM, render, RenderResult, screen, waitFor } from "@testing-library/react"; // VERJI: act, waitFor for verji/verji-src#1507
import userEvent from "@testing-library/user-event";

import SpaceContextMenu from "../../../../src/components/views/context_menus/SpaceContextMenu";
import MatrixClientContext from "../../../../src/contexts/MatrixClientContext";
import {
    shouldShowSpaceSettings,
    showCreateNewRoom,
    showCreateNewSubspace,
    showSpaceInvite,
    showSpaceSettings,
} from "../../../../src/utils/space";
import { leaveSpace } from "../../../../src/utils/leave-behaviour";
import { shouldShowComponent } from "../../../../src/customisations/helpers/UIComponents";
import { UIComponent, UIFeature } from "../../../../src/settings/UIFeature";
import SettingsStore from "../../../../src/settings/SettingsStore";
import { _t } from "../../../../src/languageHandler";
import { VerjiPermissionsStore } from "../../../../src/stores/verji/VerjiPermissionsStore";
import { mkEvent, mockStateEventImplementation } from "../../../test-utils";

jest.mock("../../../../src/customisations/helpers/UIComponents", () => ({
    shouldShowComponent: jest.fn(),
}));

jest.mock("../../../../src/utils/space", () => ({
    shouldShowSpaceSettings: jest.fn(),
    showCreateNewRoom: jest.fn(),
    showCreateNewSubspace: jest.fn(),
    showSpaceInvite: jest.fn(),
    showSpacePreferences: jest.fn(),
    showSpaceSettings: jest.fn(),
}));

jest.mock("../../../../src/utils/leave-behaviour", () => ({
    leaveSpace: jest.fn(),
}));

describe("<SpaceContextMenu />", () => {
    const userId = "@test:server";

    const mockClient = {
        getUserId: jest.fn().mockReturnValue(userId),
        getSafeUserId: jest.fn().mockReturnValue(userId),
    } as unknown as Mocked<MatrixClient>;

    const makeMockSpace = (props = {}) =>
        ({
            name: "test space",
            getJoinRule: jest.fn(),
            canInvite: jest.fn(),
            currentState: {
                maySendStateEvent: jest.fn(),
            },
            client: mockClient,
            getMyMembership: jest.fn(),
            // VERJI: read by the create-room gate; unset, the space is not a Verji space.
            isSpaceRoom: jest.fn(),
            ...props,
        }) as unknown as Room;

    const defaultProps = {
        space: makeMockSpace(),
        onFinished: jest.fn(),
    };

    const renderComponent = (props = {}): RenderResult =>
        render(
            <MatrixClientContext.Provider value={mockClient}>
                <SpaceContextMenu {...defaultProps} {...props} />
            </MatrixClientContext.Provider>,
        );

    beforeEach(() => {
        jest.resetAllMocks();
        mockClient.getUserId.mockReturnValue(userId);
        mockClient.getSafeUserId.mockReturnValue(userId);
    });

    it("renders menu correctly", () => {
        const { baseElement } = renderComponent();
        expect(prettyDOM(baseElement)).toMatchSnapshot();
    });

    it("renders invite option when space is public", () => {
        const space = makeMockSpace({
            getJoinRule: jest.fn().mockReturnValue("public"),
        });
        renderComponent({ space });
        expect(screen.getByTestId("invite-option")).toBeInTheDocument();
    });

    it("renders invite option when user is has invite rights for space", () => {
        const space = makeMockSpace({
            canInvite: jest.fn().mockReturnValue(true),
        });
        renderComponent({ space });
        expect(space.canInvite).toHaveBeenCalledWith(userId);
        expect(screen.getByTestId("invite-option")).toBeInTheDocument();
    });

    it("opens invite dialog when invite option is clicked", async () => {
        const space = makeMockSpace({
            getJoinRule: jest.fn().mockReturnValue("public"),
        });
        const onFinished = jest.fn();
        renderComponent({ space, onFinished });

        await userEvent.click(screen.getByTestId("invite-option"));

        expect(showSpaceInvite).toHaveBeenCalledWith(space);
        expect(onFinished).toHaveBeenCalled();
    });

    it("renders space settings option when user has rights", () => {
        mocked(shouldShowSpaceSettings).mockReturnValue(true);
        renderComponent();
        expect(shouldShowSpaceSettings).toHaveBeenCalledWith(defaultProps.space);
        expect(screen.getByTestId("settings-option")).toBeInTheDocument();
    });

    it("opens space settings when space settings option is clicked", async () => {
        mocked(shouldShowSpaceSettings).mockReturnValue(true);
        const onFinished = jest.fn();
        renderComponent({ onFinished });

        await userEvent.click(screen.getByTestId("settings-option"));

        expect(showSpaceSettings).toHaveBeenCalledWith(defaultProps.space);
        expect(onFinished).toHaveBeenCalled();
    });

    it("renders leave option when user does not have rights to see space settings", () => {
        renderComponent();
        expect(screen.getByTestId("leave-option")).toBeInTheDocument();
    });

    it("leaves space when leave option is clicked", async () => {
        const onFinished = jest.fn();
        renderComponent({ onFinished });
        await userEvent.click(screen.getByTestId("leave-option"));
        expect(leaveSpace).toHaveBeenCalledWith(defaultProps.space);
        expect(onFinished).toHaveBeenCalled();
    });

    describe("add children section", () => {
        const space = makeMockSpace();

        beforeEach(() => {
            // set space to allow adding children to space
            mocked(space.currentState.maySendStateEvent).mockReturnValue(true);
            mocked(shouldShowComponent).mockReturnValue(true);
        });

        it("does not render section when user does not have permission to add children", () => {
            mocked(space.currentState.maySendStateEvent).mockReturnValue(false);
            renderComponent({ space });

            expect(screen.queryByTestId("add-to-space-header")).not.toBeInTheDocument();
            expect(screen.queryByTestId("new-room-option")).not.toBeInTheDocument();
            expect(screen.queryByTestId("new-subspace-option")).not.toBeInTheDocument();
        });

        it("does not render section when UIComponent customisations disable room and space creation", () => {
            mocked(shouldShowComponent).mockReturnValue(false);
            renderComponent({ space });

            expect(shouldShowComponent).toHaveBeenCalledWith(UIComponent.CreateRooms);
            expect(shouldShowComponent).toHaveBeenCalledWith(UIComponent.CreateSpaces);

            expect(screen.queryByTestId("add-to-space-header")).not.toBeInTheDocument();
            expect(screen.queryByTestId("new-room-option")).not.toBeInTheDocument();
            expect(screen.queryByTestId("new-subspace-option")).not.toBeInTheDocument();
        });

        it("renders section with add room button when UIComponent customisation allows CreateRoom", () => {
            // only allow CreateRoom
            mocked(shouldShowComponent).mockImplementation((feature) => feature === UIComponent.CreateRooms);
            renderComponent({ space });

            expect(screen.getByTestId("add-to-space-header")).toBeInTheDocument();
            expect(screen.getByTestId("new-room-option")).toBeInTheDocument();
            expect(screen.queryByTestId("new-subspace-option")).not.toBeInTheDocument();
        });

        it("renders section with add space button when UIComponent customisation allows CreateSpace", () => {
            // only allow CreateSpaces
            mocked(shouldShowComponent).mockImplementation((feature) => feature === UIComponent.CreateSpaces);
            renderComponent({ space });

            expect(screen.getByTestId("add-to-space-header")).toBeInTheDocument();
            expect(screen.queryByTestId("new-room-option")).not.toBeInTheDocument();
            expect(screen.getByTestId("new-subspace-option")).toBeInTheDocument();
        });

        it("opens create room dialog on add room button click", async () => {
            const onFinished = jest.fn();
            renderComponent({ space, onFinished });

            await userEvent.click(screen.getByTestId("new-room-option"));
            expect(showCreateNewRoom).toHaveBeenCalledWith(space);
            expect(onFinished).toHaveBeenCalled();
        });

        it("opens create space dialog on add space button click", async () => {
            const onFinished = jest.fn();
            renderComponent({ space, onFinished });

            await userEvent.click(screen.getByTestId("new-subspace-option"));
            expect(showCreateNewSubspace).toHaveBeenCalledWith(space);
            expect(onFinished).toHaveBeenCalled();
        });
    });

    // VERJI: Hierarchy V2 — the menu's "Room" option follows the same create-room rule as the
    // room list's Rooms "+".
    describe("the Hierarchy V2 create-room gate", () => {
        const TENANT = "tenant-1";
        const ORG_A = "org-a";
        const STANDARD_USER = { "Customer-User#": [TENANT] };

        /** A space carrying Verji state, keyed on its own type as itops-matrix writes it. */
        const makeVerjiSpace = (events: Record<string, object>): Room => {
            const roomId = "!verji-space:server";
            const state = Object.entries(events).map(([type, content]) =>
                mkEvent({ event: true, type, room: roomId, user: userId, skey: type, content, ts: Date.now() }),
            );
            return makeMockSpace({
                roomId,
                isSpaceRoom: jest.fn().mockReturnValue(true),
                currentState: {
                    maySendStateEvent: jest.fn().mockReturnValue(true),
                    getStateEvents: jest.fn().mockImplementation(mockStateEventImplementation(state)),
                },
            });
        };
        const TENANT_INFO = { "app.verji.tenant_info": { tenant_id: TENANT } };
        const PARENT = { "app.verji.canonical_parent_space": { canonical_parent_space_id: "!parent:server" } };

        /**
         * Grants are read at call time, so a test can change them and bump the store to play a
         * fetch that brought new roles.
         *
         * @param exhausted OrgUnits whose re-fetch the store has used up (verji/verji-src#1507)
         */
        const mockStore = (
            rolloutOn: boolean,
            grants: Record<string, string[]> = {},
            exhausted: string[] = [],
        ): void => {
            jest.spyOn(VerjiPermissionsStore.instance, "isCanonicalSpaceSyncEnabled").mockImplementation(
                (tenantId) => rolloutOn && tenantId === TENANT,
            );
            jest.spyOn(VerjiPermissionsStore.instance, "hasRole").mockImplementation(
                (tenantId, roleName, instanceId) =>
                    tenantId === TENANT && (grants[roleName] ?? []).includes(instanceId),
            );
            jest.spyOn(VerjiPermissionsStore.instance, "isInstanceReferenced").mockImplementation(
                (tenantId, instanceId) =>
                    tenantId === TENANT && Object.values(grants).some((instances) => instances.includes(instanceId)),
            );
            jest.spyOn(VerjiPermissionsStore.instance, "isOrgUnitRefreshExhausted").mockImplementation(
                (tenantId, orgUnitId) => tenantId === TENANT && exhausted.includes(orgUnitId),
            );
        };

        beforeEach(() => {
            mocked(shouldShowComponent).mockReturnValue(true);
        });

        afterEach(() => {
            jest.restoreAllMocks();
        });

        it("offers the room option exactly as today when the rollout switch is off", async () => {
            mockStore(false, {});
            const space = makeVerjiSpace(TENANT_INFO);
            renderComponent({ space });

            const option = screen.getByTestId("new-room-option");
            expect(option).not.toHaveAttribute("aria-disabled", "true");
            await userEvent.click(option);
            expect(showCreateNewRoom).toHaveBeenCalledWith(space);
        });

        it("disables the room option for a Guest, with the guest hint, and does not open the dialog", async () => {
            mockStore(true, {});
            renderComponent({ space: makeVerjiSpace(TENANT_INFO) });

            const option = screen.getByTestId("new-room-option");
            expect(option).toHaveAttribute("aria-disabled", "true");
            await userEvent.hover(option);
            expect((await screen.findByRole("tooltip")).textContent).toContain("You are a guest in");
            await userEvent.click(option);
            expect(showCreateNewRoom).not.toHaveBeenCalled();
        });

        it("keeps the room option for a StandardUser at a TenantRoot", () => {
            mockStore(true, STANDARD_USER);
            renderComponent({ space: makeVerjiSpace(TENANT_INFO) });

            expect(screen.getByTestId("new-room-option")).not.toHaveAttribute("aria-disabled", "true");
        });

        it("removes the room option at an OrgUnitCategory", () => {
            mockStore(true, STANDARD_USER);
            renderComponent({ space: makeVerjiSpace({ ...TENANT_INFO, ...PARENT }) });

            expect(screen.queryByTestId("new-room-option")).not.toBeInTheDocument();
        });

        it("keeps the room option for the guest org's Owner at that OrgUnit", () => {
            mockStore(true, { ...STANDARD_USER, "ClientOrganization-Owner": [ORG_A] });
            renderComponent({
                space: makeVerjiSpace({ ...TENANT_INFO, ...PARENT, "app.verji.org_unit_info": { org_unit_id: ORG_A } }),
            });

            expect(screen.getByTestId("new-room-option")).not.toHaveAttribute("aria-disabled", "true");
        });

        // VERJI: verji/verji-src#1507 — a guest org created after the access context was fetched.
        describe("at an OrgUnit the cached context has never heard of", () => {
            const ORG_UNIT_INFO = { "app.verji.org_unit_info": { org_unit_id: ORG_A } };

            it("disables the room options with the checking hint, then enables them when the Owner row lands", async () => {
                // Video rooms on, so the "Video room" option renders too: it reads the same gate.
                jest.spyOn(SettingsStore, "getValue").mockImplementation((name) => name === "feature_video_rooms");
                const grants: Record<string, string[]> = { ...STANDARD_USER };
                mockStore(true, grants);
                const space = makeVerjiSpace({ ...TENANT_INFO, ...PARENT, ...ORG_UNIT_INFO });
                renderComponent({ space });

                const room = screen.getByTestId("new-room-option");
                const videoRoom = screen.getByTestId("new-video-room-option");
                expect(room).toHaveAttribute("aria-disabled", "true");
                expect(videoRoom).toHaveAttribute("aria-disabled", "true");
                await userEvent.hover(room);
                expect((await screen.findByRole("tooltip")).textContent).toContain("Checking your access");
                await userEvent.click(room);
                expect(showCreateNewRoom).not.toHaveBeenCalled();

                // A re-fetch brought the Owner row: the SDK emits, and the store re-renders its readers.
                grants["ClientOrganization-Owner"] = [ORG_A];
                act(() => {
                    VerjiPermissionsStore.instance["bumpVersion"]();
                });

                // Re-queried: with no hint left to show, the option drops its tooltip wrapper, so
                // React mounts a new element in place of the one held above.
                await waitFor(() =>
                    expect(screen.getByTestId("new-room-option")).not.toHaveAttribute("aria-disabled", "true"),
                );
                expect(screen.getByTestId("new-video-room-option")).not.toHaveAttribute("aria-disabled", "true");
                await userEvent.click(screen.getByTestId("new-room-option"));
                expect(showCreateNewRoom).toHaveBeenCalledWith(space);
            });

            it("settles on the not-a-member hint once the store's re-fetch is used up", async () => {
                mockStore(true, STANDARD_USER, [ORG_A]);
                renderComponent({ space: makeVerjiSpace({ ...TENANT_INFO, ...PARENT, ...ORG_UNIT_INFO }) });

                const option = screen.getByTestId("new-room-option");
                expect(option).toHaveAttribute("aria-disabled", "true");
                await userEvent.hover(option);
                expect((await screen.findByRole("tooltip")).textContent).toContain("not a member of this organisation");
            });
        });
    });

    describe("UIFeature.ShowLeaveSpaceInContextMenu", () => {
        it("ShowLeaveSpaceInContextMenu = true, renders 'leave space' option", () => {
            mocked(shouldShowSpaceSettings).mockReturnValue(false);
            jest.spyOn(SettingsStore, "getValue").mockImplementation((val) => {
                return val === UIFeature.ShowLeaveSpaceInContextMenu ? true : "default";
            });
            renderComponent();

            expect(screen.getByTestId("leave-option")).toBeInTheDocument();
        });

        it("ShowLeaveSpaceInContextMenu = false, does not render 'leave space' option", () => {
            mocked(shouldShowSpaceSettings).mockReturnValue(false);
            jest.spyOn(SettingsStore, "getValue").mockImplementation((val) => {
                return val === UIFeature.ShowLeaveSpaceInContextMenu ? false : "default";
            });
            renderComponent();

            expect(screen.queryByTestId("leave-option")).not.toBeInTheDocument();
        });
    });

    describe("UIFeature.AddSubSpace feature flag", () => {
        const space = makeMockSpace();

        beforeEach(() => {
            // set space to allow adding children to space
            mocked(space.currentState.maySendStateEvent).mockReturnValue(true);
            mocked(shouldShowComponent).mockReturnValue(true);
            jest.clearAllMocks();
        });

        it("UIFeature.AddSubSpace = true: renders create space button when UIFeature is true", () => {
            jest.spyOn(SettingsStore, "getValue").mockImplementation((name) => {
                if (name === UIFeature.AddSubSpace) return true;
                else return "default";
            });
            renderComponent({ space });

            screen.debug();

            expect(screen.getByTestId("add-to-space-header")).toBeInTheDocument();
            expect(screen.getByTestId("new-room-option")).toBeInTheDocument();
            expect(screen.queryByTestId("new-subspace-option")).toBeInTheDocument();
        });

        it("UIFeature.AddSubSpace = false: does not render create space button when UIFeature is false", () => {
            jest.spyOn(SettingsStore, "getValue").mockImplementation((name) => {
                if (name === UIFeature.AddSubSpace) return false;
                else return "default";
            });
            renderComponent({ space });

            expect(screen.getByTestId("add-to-space-header")).toBeInTheDocument();
            expect(screen.getByTestId("new-room-option")).toBeInTheDocument();
            expect(screen.queryByTestId("new-subspace-option")).not.toBeInTheDocument();
        });
    });

    describe("UIFeature.ShowSpaceLandingPageDetails", () => {
        it("ShowSpaceLandingPageDetails = true, renders 'Manage & explore rooms' | 'explore rooms' option", () => {
            mocked(shouldShowSpaceSettings).mockReturnValue(false);
            jest.spyOn(SettingsStore, "getValue").mockImplementation((val) => {
                return val === UIFeature.ShowSpaceLandingPageDetails ? true : "default";
            });
            renderComponent();

            const textToFind = screen.queryByText(_t("space|context_menu|manage_and_explore"))
                ? _t("space|context_menu|manage_and_explore")
                : _t("space|context_menu|explore");
            expect(screen.queryByText(textToFind)).toBeInTheDocument();
        });

        it("ShowSpaceLandingPageDetails = false, does not render 'Manage & explore rooms' | 'explore rooms' option", () => {
            mocked(shouldShowSpaceSettings).mockReturnValue(false);
            jest.spyOn(SettingsStore, "getValue").mockImplementation((val) => {
                return val === UIFeature.ShowSpaceLandingPageDetails ? false : "default";
            });
            renderComponent();

            const textToFind = screen.queryByText(_t("space|context_menu|manage_and_explore"))
                ? _t("space|context_menu|manage_and_explore")
                : _t("space|context_menu|explore");
            expect(screen.queryByText(textToFind)).not.toBeInTheDocument();
        });
    });
});
