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
import SdkConfig from "../../../../src/SdkConfig"; // VERJI: verji/verji-src#2117
import { _t } from "../../../../src/languageHandler";
import { VerjiPermissionsStore } from "../../../../src/stores/verji/VerjiPermissionsStore";
import { mkEvent, mockStateEventImplementation } from "../../../test-utils";
import { showAddExistingGuestOrgDialog } from "../../../../src/components/views/dialogs/verji/AddExistingGuestOrgDialog"; // VERJI: verji/verji-src#2117
import { showAddExistingRoomToOrgUnitDialog } from "../../../../src/components/views/dialogs/verji/AddExistingRoomToOrgUnitDialog"; // VERJI: verji/verji-src#2117
import { getOrgUnitsWithoutCategory } from "../../../../src/stores/verji/verjiOrgUnitRooms"; // VERJI: verji/verji-src#2117

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

// VERJI: verji/verji-src#2117
jest.mock("../../../../src/components/views/dialogs/verji/AddExistingGuestOrgDialog", () => ({
    showAddExistingGuestOrgDialog: jest.fn(),
}));
jest.mock("../../../../src/components/views/dialogs/verji/AddExistingRoomToOrgUnitDialog", () => ({
    showAddExistingRoomToOrgUnitDialog: jest.fn(),
}));
// The Organization API's answer to which org units have no category; whether it is configured is not mocked.
jest.mock("../../../../src/stores/verji/verjiOrgUnitRooms", () => ({
    ...jest.requireActual("../../../../src/stores/verji/verjiOrgUnitRooms"),
    getOrgUnitsWithoutCategory: jest.fn(),
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

        it("keeps the room option for the tenant's PrimaryContact at an OrgUnit they are not a Member of", async () => {
            // verji/verji-src#1712: ORG_A reaches them only through the expanded Manager role.
            mockStore(true, {
                ...STANDARD_USER,
                "Customer-Manager#": [TENANT],
                "ClientOrganization-Manager": [TENANT, ORG_A],
            });
            const space = makeVerjiSpace({
                ...TENANT_INFO,
                ...PARENT,
                "app.verji.org_unit_info": { org_unit_id: ORG_A },
            });
            renderComponent({ space });

            const option = screen.getByTestId("new-room-option");
            expect(option).not.toHaveAttribute("aria-disabled", "true");
            await userEvent.click(option);
            expect(showCreateNewRoom).toHaveBeenCalledWith(space);
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

    // VERJI: verji/verji-src#2117 — the tenant's PrimaryContact, and a guest org's Owner for their
    // own, bring guest orgs and rooms from before Hierarchy V2 in. The store's reads are real here,
    // fed by a mocked SDK store, so the menu, the hooks, the gates and the role contract are tested
    // together; only the Organization API's list of org units stands in.
    describe("the Hierarchy V2 add-existing options", () => {
        const TENANT = "tenant-1";
        const ORG_A = "org-a";
        const ORG_B = "org-b";
        const STANDARD_USER = { "Customer-User#": [TENANT] };
        const PRIMARY_CONTACT = { "Customer-User#": [TENANT], "Customer-Manager#": [TENANT] };
        const OWNER_OF_A = { ...STANDARD_USER, "ClientOrganization-Owner": [ORG_A] };
        const TENANT_INFO = { "app.verji.tenant_info": { tenant_id: TENANT } };
        const PARENT = { "app.verji.canonical_parent_space": { canonical_parent_space_id: "!parent:server" } };
        const CATEGORY = { ...TENANT_INFO, ...PARENT };
        const ORG_UNIT = { ...TENANT_INFO, ...PARENT, "app.verji.org_unit_info": { org_unit_id: ORG_A } };

        /**
         * A Verji space on which the user, like a PrimaryContact in their personal space, may not
         * send m.space.child: the options must not depend on it.
         */
        const makeVerjiSpace = (events: Record<string, object>): Room => {
            const roomId = "!verji-space:server";
            const state = Object.entries(events).map(([type, content]) =>
                mkEvent({ event: true, type, room: roomId, user: userId, skey: type, content, ts: Date.now() }),
            );
            return makeMockSpace({
                roomId,
                isSpaceRoom: jest.fn().mockReturnValue(true),
                currentState: {
                    maySendStateEvent: jest.fn().mockReturnValue(false),
                    getStateEvents: jest.fn().mockImplementation(mockStateEventImplementation(state)),
                },
            });
        };

        /** Feeds the bridge store's real reads from a stand-in for the SDK's access-context store. */
        const mockStore = (rolloutOn: boolean, grants: Record<string, string[]>): void => {
            const permissions = {
                isCanonicalSpaceSyncEnabled: (tenantId: string) => rolloutOn && tenantId === TENANT,
                hasRole: (tenantId: string, roleName: string, instanceId: string) =>
                    tenantId === TENANT && (grants[roleName] ?? []).includes(instanceId),
                peekContext: () => ({ status: "fresh", record: { roles: grants } }),
                // The create-room gate reads Checking for a StandardUser at an OrgUnit the context
                // has not heard of, and the store then re-fetches.
                refreshContext: jest.fn().mockResolvedValue(undefined),
                ensureContextFresh: jest.fn().mockResolvedValue(undefined),
            };
            (VerjiPermissionsStore.instance as unknown as { permissions: unknown }).permissions = permissions;
        };

        beforeEach(() => {
            mocked(shouldShowComponent).mockReturnValue(true);
            // The options call the Organization API, so they are offered only where it is configured.
            SdkConfig.put({ verjiItopsUrl: "https://itops.test", verjiOrganizationUrl: "https://org.test" } as never);
            mocked(getOrgUnitsWithoutCategory).mockResolvedValue([]);
        });

        /** Let the Organization API's answer land. */
        const settle = async (): Promise<void> => {
            await act(async () => {
                await Promise.resolve();
            });
        };

        afterEach(() => {
            VerjiPermissionsStore.instance["resetFreshnessRequests"]();
            (VerjiPermissionsStore.instance as unknown as { permissions: unknown }).permissions = undefined;
            SdkConfig.reset();
            jest.restoreAllMocks();
        });

        it("offers the PrimaryContact 'Add existing Guest Organization' at a category, under the Add header", async () => {
            mockStore(true, PRIMARY_CONTACT);
            const onFinished = jest.fn();
            const space = makeVerjiSpace(CATEGORY);
            renderComponent({ space, onFinished });

            expect(screen.getByTestId("add-to-space-header")).toBeInTheDocument();
            expect(screen.queryByTestId("add-existing-room-option")).not.toBeInTheDocument();
            const option = screen.getByTestId("add-existing-guest-org-option");
            expect(option).toHaveTextContent("Add existing Guest Organization");
            await userEvent.click(option);
            expect(showAddExistingGuestOrgDialog).toHaveBeenCalledWith(space);
            expect(onFinished).toHaveBeenCalled();
        });

        it("offers the PrimaryContact 'Add existing room' at a guest org", async () => {
            mockStore(true, PRIMARY_CONTACT);
            const onFinished = jest.fn();
            const space = makeVerjiSpace(ORG_UNIT);
            renderComponent({ space, onFinished });

            expect(screen.getByTestId("add-to-space-header")).toBeInTheDocument();
            expect(screen.queryByTestId("add-existing-guest-org-option")).not.toBeInTheDocument();
            const option = screen.getByTestId("add-existing-room-option");
            expect(option).toHaveTextContent("Add existing room");
            await userEvent.click(option);
            expect(showAddExistingRoomToOrgUnitDialog).toHaveBeenCalledWith(space);
            expect(onFinished).toHaveBeenCalled();
        });

        it("offers the PrimaryContact 'Add existing Guest Organization' at the tenant root too, without asking", async () => {
            mockStore(true, PRIMARY_CONTACT);
            const space = makeVerjiSpace(TENANT_INFO);
            renderComponent({ space });

            expect(screen.queryByTestId("add-existing-room-option")).not.toBeInTheDocument();
            await userEvent.click(screen.getByTestId("add-existing-guest-org-option"));
            expect(showAddExistingGuestOrgDialog).toHaveBeenCalledWith(space);
            // The PrimaryContact may bring in any org unit of the tenant: nothing to ask.
            expect(getOrgUnitsWithoutCategory).not.toHaveBeenCalled();
        });

        it("offers the guest org's Owner 'Add existing room' at their guest org", async () => {
            mockStore(true, OWNER_OF_A);
            const space = makeVerjiSpace(ORG_UNIT);
            renderComponent({ space });

            await userEvent.click(screen.getByTestId("add-existing-room-option"));
            expect(showAddExistingRoomToOrgUnitDialog).toHaveBeenCalledWith(space);
        });

        it("does not offer 'Add existing room' to the Owner of another guest org", () => {
            mockStore(true, { ...STANDARD_USER, "ClientOrganization-Owner": [ORG_B] });
            renderComponent({ space: makeVerjiSpace(ORG_UNIT) });

            expect(screen.queryByTestId("add-existing-room-option")).not.toBeInTheDocument();
        });

        it.each([
            ["the tenant root", TENANT_INFO],
            ["a category", CATEGORY],
        ])(
            "offers an Owner 'Add existing Guest Organization' at %s once one of theirs has no category",
            async (_where, events) => {
                mockStore(true, OWNER_OF_A);
                mocked(getOrgUnitsWithoutCategory).mockResolvedValue([
                    { id: ORG_A, name: "Kari AS", orgUnitCategoryId: null },
                ]);
                const space = makeVerjiSpace(events);
                renderComponent({ space });

                await userEvent.click(await screen.findByTestId("add-existing-guest-org-option"));
                expect(showAddExistingGuestOrgDialog).toHaveBeenCalledWith(space);
                expect(getOrgUnitsWithoutCategory).toHaveBeenCalledWith(
                    space.client,
                    TENANT,
                    VerjiPermissionsStore.instance,
                );
            },
        );

        it.each([
            ["every one of theirs has a category", () => mocked(getOrgUnitsWithoutCategory).mockResolvedValue([])],
            [
                "the list cannot be read",
                () => mocked(getOrgUnitsWithoutCategory).mockRejectedValue(new Error("forbidden")),
            ],
        ])("does not offer an Owner 'Add existing Guest Organization' when %s", async (_when, answer) => {
            mockStore(true, OWNER_OF_A);
            answer();

            renderComponent({ space: makeVerjiSpace(TENANT_INFO) });
            await settle();

            expect(getOrgUnitsWithoutCategory).toHaveBeenCalled();
            expect(screen.queryByTestId("add-existing-guest-org-option")).not.toBeInTheDocument();
            expect(screen.queryByTestId("add-to-space-header")).not.toBeInTheDocument();
        });

        it("changes nothing when the answer arrives after the menu closed", async () => {
            mockStore(true, OWNER_OF_A);
            let resolve!: (orgUnits: never[]) => void;
            mocked(getOrgUnitsWithoutCategory).mockReturnValue(new Promise((res) => (resolve = res)));
            const errors = jest.spyOn(console, "error");

            const { unmount } = renderComponent({ space: makeVerjiSpace(TENANT_INFO) });
            unmount();
            await act(async () => {
                resolve([]);
            });

            expect(errors.mock.calls.filter((call) => String(call[0]).includes("unmounted component"))).toEqual([]);
        });

        it.each([
            ["a StandardUser", STANDARD_USER],
            ["a Guest who is a Member of the guest org", { "ClientOrganization-User#": [ORG_A] }],
            [
                "the guest org's own PrimaryContact",
                { "ClientOrganization-User#": [ORG_A], "ClientOrganization-Manager#": [ORG_A] },
            ],
        ])("offers neither to %s, asks nothing, and leaves no Add header behind", async (_who, grants) => {
            mockStore(true, grants);

            for (const events of [TENANT_INFO, CATEGORY, ORG_UNIT]) {
                const { unmount } = renderComponent({ space: makeVerjiSpace(events) });
                await settle();
                expect(screen.queryByTestId("add-existing-guest-org-option")).not.toBeInTheDocument();
                expect(screen.queryByTestId("add-existing-room-option")).not.toBeInTheDocument();
                expect(screen.queryByTestId("add-to-space-header")).not.toBeInTheDocument();
                unmount();
            }
            expect(getOrgUnitsWithoutCategory).not.toHaveBeenCalled();
        });

        it("offers neither, and no Add header, when the Organization API is not configured", () => {
            mockStore(true, PRIMARY_CONTACT);
            SdkConfig.put({ verjiItopsUrl: "https://itops.test" } as never);

            for (const events of [TENANT_INFO, CATEGORY, ORG_UNIT]) {
                const { unmount } = renderComponent({ space: makeVerjiSpace(events) });
                expect(screen.queryByTestId("add-existing-guest-org-option")).not.toBeInTheDocument();
                expect(screen.queryByTestId("add-existing-room-option")).not.toBeInTheDocument();
                expect(screen.queryByTestId("add-to-space-header")).not.toBeInTheDocument();
                unmount();
            }
        });

        it("offers neither, and no Add header, when Hierarchy V2 is off for the tenant", () => {
            mockStore(false, PRIMARY_CONTACT);

            for (const events of [TENANT_INFO, CATEGORY, ORG_UNIT]) {
                const { unmount } = renderComponent({ space: makeVerjiSpace(events) });
                expect(screen.queryByTestId("add-existing-guest-org-option")).not.toBeInTheDocument();
                expect(screen.queryByTestId("add-existing-room-option")).not.toBeInTheDocument();
                expect(screen.queryByTestId("add-to-space-header")).not.toBeInTheDocument();
                unmount();
            }
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

        // VERJI: the header renders only over an option that renders (verji/verji-src#2117).
        it("UIFeature.AddSubSpace = false: leaves no empty Add header when a space is the only option allowed", () => {
            mocked(shouldShowComponent).mockImplementation((feature) => feature === UIComponent.CreateSpaces);
            jest.spyOn(SettingsStore, "getValue").mockImplementation((name) => {
                if (name === UIFeature.AddSubSpace) return false;
                else return "default";
            });
            renderComponent({ space });

            expect(screen.queryByTestId("add-to-space-header")).not.toBeInTheDocument();
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
