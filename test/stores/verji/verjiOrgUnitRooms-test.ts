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

import { MatrixClient, Room } from "matrix-js-sdk/src/matrix";
import { KnownMembership, Membership } from "matrix-js-sdk/src/types";
import { mocked } from "jest-mock";
import { getVerjiApiSdk } from "@verji/verji-api-sdk/lib/asyncInit";
import { OrgUnitRoomConflictError } from "@verji/verji-api-sdk";

import {
    askHasOrgUnitWithoutCategory,
    assignDefaultOrgUnitCategory,
    assignRoomToOrgUnit,
    BRING_IN_SETTLES_AFTER_MS,
    bringInClock,
    currentSignedInUser,
    describeError,
    findOrgUnitSpace,
    forgetHasOrgUnitWithoutCategory,
    getConflictReason,
    getOrgUnitName,
    getOrgUnitRoomCandidates,
    getOrgUnitsWithoutCategory,
    isForbidden,
    isOrganizationApiConfigured,
    knownHasOrgUnitWithoutCategory,
    markBringingIn,
    markBroughtIn,
    rememberHasOrgUnitWithoutCategory,
    setSignedInUser,
} from "../../../src/stores/verji/verjiOrgUnitRooms";
import SdkConfig from "../../../src/SdkConfig";
import { VerjiRoleReader } from "../../../src/stores/verji/verjiRoles";
import { mkEvent, mockStateEventImplementation } from "../../test-utils";

// VERJI: verji/verji-src#2117
jest.mock("@verji/verji-api-sdk/lib/asyncInit", () => ({ getVerjiApiSdk: jest.fn() }));

const TOKEN = { access_token: "verji-token" };

describe("verjiOrgUnitRooms", () => {
    const client = { getAccessToken: () => "macaroon" } as unknown as MatrixClient;
    const getAccessToken = jest.fn();
    const organization = {
        getOrgUnits: jest.fn(),
        assignDefaultOrgUnitCategory: jest.fn(),
        getOrgUnitRoomCandidates: jest.fn(),
        assignRoomToOrgUnit: jest.fn(),
    };

    const sdkWith = (organizationService: unknown): void => {
        mocked(getVerjiApiSdk).mockResolvedValue({
            api: { identityService: { getAccessToken }, organizationService },
        } as never);
    };

    beforeEach(() => {
        jest.resetAllMocks();
        getAccessToken.mockResolvedValue(TOKEN);
        sdkWith(organization);
    });

    /** A reader of t1's access context with these grants; it knows nothing of any other tenant. */
    const rolesFor = (grants: Record<string, string[]>): VerjiRoleReader => ({
        hasRole: (tenantId, roleName, instanceId) => tenantId === "t1" && (grants[roleName] ?? []).includes(instanceId),
        isInstanceReferenced: () => false,
        getRoleInstances: (tenantId, roleName) => (tenantId === "t1" ? grants[roleName] ?? [] : []),
    });
    const PRIMARY_CONTACT = rolesFor({ "Customer-Manager#": ["t1"] });

    it("lists only the org units that have no category, with a token minted from the client's macaroon", async () => {
        organization.getOrgUnits.mockResolvedValue({
            results: [
                { id: "u1", name: "In already", orgUnitCategoryId: "cat-1" },
                { id: "u2", name: "From before", orgUnitCategoryId: null },
            ],
        });

        await expect(getOrgUnitsWithoutCategory(client, "t1", PRIMARY_CONTACT)).resolves.toEqual([
            { id: "u2", name: "From before", orgUnitCategoryId: null },
        ]);
        expect(getAccessToken).toHaveBeenCalledWith("macaroon");
        expect(organization.getOrgUnits).toHaveBeenCalledWith(TOKEN, "t1");
    });

    // VERJI: verji/verji-src#2117 — the tenant's PrimaryContact brings in any, an Owner their own.
    it.each([
        ["the tenant's PrimaryContact, every one", PRIMARY_CONTACT, ["u2", "u3"]],
        ["an Owner, their own", rolesFor({ "ClientOrganization-Owner": ["u3", "u1"] }), ["u3"]],
        ["the org unit's own PrimaryContact, none", rolesFor({ "ClientOrganization-Manager#": ["u2"] }), []],
        ["a StandardUser who owns nothing, none", rolesFor({ "Customer-User#": ["t1"] }), []],
    ])("lists %s", async (_who, roles, expected) => {
        organization.getOrgUnits.mockResolvedValue({
            results: [
                { id: "u1", name: "In already", orgUnitCategoryId: "cat-1" },
                { id: "u2", name: "From before", orgUnitCategoryId: null },
                { id: "u3", name: "Also from before", orgUnitCategoryId: null },
            ],
        });

        const listed = await getOrgUnitsWithoutCategory(client, "t1", roles);

        expect(listed.map((orgUnit) => orgUnit.id)).toEqual(expected);
    });

    it("passes the tenant, the org unit and the room on to the Organization API", async () => {
        organization.getOrgUnitRoomCandidates.mockResolvedValue({ results: [] });

        await assignDefaultOrgUnitCategory(client, "t1", "u1");
        await getOrgUnitRoomCandidates(client, "t1", "u1");
        await assignRoomToOrgUnit(client, "t1", "u1", "!r:server");

        expect(organization.assignDefaultOrgUnitCategory).toHaveBeenCalledWith(TOKEN, "t1", "u1");
        expect(organization.getOrgUnitRoomCandidates).toHaveBeenCalledWith(TOKEN, "t1", "u1");
        expect(organization.assignRoomToOrgUnit).toHaveBeenCalledWith(TOKEN, "t1", "u1", "!r:server");
    });

    it("fails clearly when the Organization API is not configured", async () => {
        sdkWith(undefined);

        await expect(getOrgUnitsWithoutCategory(client, "t1", PRIMARY_CONTACT)).rejects.toThrow("verjiOrganizationUrl");
    });

    describe("isOrganizationApiConfigured", () => {
        afterEach(() => SdkConfig.reset());

        it("answers whether the config the SDK is created from names the Organization API", () => {
            SdkConfig.put({ verjiItopsUrl: "https://itops.test", verjiOrganizationUrl: "https://org.test" } as never);
            expect(isOrganizationApiConfigured()).toBe(true);

            SdkConfig.put({ verjiItopsUrl: "https://itops.test" } as never);
            expect(isOrganizationApiConfigured()).toBe(false);

            SdkConfig.put({ verjiItopsUrl: "https://itops.test", verjiOrganizationUrl: "" } as never);
            expect(isOrganizationApiConfigured()).toBe(false);
        });
    });

    describe("findOrgUnitSpace", () => {
        /** A space carrying the Verji state a guest org's personal space carries, sent by vsys unless `sender` says. */
        const makeSpace = (
            roomId: string,
            membership: Membership,
            tenantId = "t1",
            orgUnitId = "u1",
            sender = "@vsys:server",
        ): Room => {
            const state = [
                mkEvent({
                    event: true,
                    type: "app.verji.tenant_info",
                    skey: "app.verji.tenant_info",
                    room: roomId,
                    user: sender,
                    content: { tenant_id: tenantId },
                }),
                mkEvent({
                    event: true,
                    type: "app.verji.org_unit_info",
                    skey: "app.verji.org_unit_info",
                    room: roomId,
                    user: sender,
                    content: { org_unit_id: orgUnitId },
                }),
            ];
            return {
                roomId,
                client: { getDomain: () => "server" },
                isSpaceRoom: () => true,
                getMyMembership: () => membership,
                currentState: { getStateEvents: jest.fn().mockImplementation(mockStateEventImplementation(state)) },
            } as unknown as Room;
        };
        const withRooms = (rooms: Room[]): MatrixClient => ({ getRooms: () => rooms }) as unknown as MatrixClient;

        it("finds the space of the tenant's org unit the client has joined", () => {
            const joined = makeSpace("!joined:server", KnownMembership.Join);
            const rooms = [
                makeSpace("!other-org:server", KnownMembership.Join, "t1", "u2"),
                makeSpace("!other-tenant:server", KnownMembership.Join, "t2", "u1"),
                joined,
            ];

            expect(findOrgUnitSpace(withRooms(rooms), "t1", "u1")).toBe(joined);
            expect(findOrgUnitSpace(withRooms(rooms.slice(0, 2)), "t1", "u1")).toBeNull();
        });

        it.each([KnownMembership.Invite, KnownMembership.Leave])("passes over a space the client is %s in", (mship) => {
            expect(findOrgUnitSpace(withRooms([makeSpace("!space:server", mship)]), "t1", "u1")).toBeNull();
        });

        it("passes over a space whose Verji events someone other than vsys sent: anyone may stamp a space of their own", () => {
            const forged = makeSpace("!forged:server", KnownMembership.Join, "t1", "u1", "@mallory:server");
            const ours = makeSpace("!ours:server", KnownMembership.Join);

            expect(findOrgUnitSpace(withRooms([forged]), "t1", "u1")).toBeNull();
            expect(findOrgUnitSpace(withRooms([forged, ours]), "t1", "u1")).toBe(ours);
        });
    });

    describe("the org unit's own name", () => {
        it("is the name the Organization API lists it under", async () => {
            organization.getOrgUnits.mockResolvedValue({
                results: [
                    { id: "u1", name: "Kari AS", orgUnitCategoryId: "cat-1" },
                    { id: "u2", name: "Ola AS", orgUnitCategoryId: null },
                ],
            });

            await expect(getOrgUnitName(client, "t1", "u2")).resolves.toBe("Ola AS");
            expect(organization.getOrgUnits).toHaveBeenCalledWith(TOKEN, "t1");
        });

        it("is unknown when the Organization API does not list the org unit", async () => {
            organization.getOrgUnits.mockResolvedValue({
                results: [{ id: "u1", name: "Kari AS", orgUnitCategoryId: null }],
            });

            await expect(getOrgUnitName(client, "t1", "u9")).resolves.toBeUndefined();
        });
    });

    describe("whether the user has an org unit to bring in, as last answered", () => {
        // As `VerjiPermissionsStore.onReady` does: the menus and the dialogs ask while a user is signed in.
        beforeEach(() => setSignedInUser("@alice:server"));
        afterEach(() => forgetHasOrgUnitWithoutCategory());

        it("is kept per tenant, and holds only under the access context it was asked under", () => {
            rememberHasOrgUnitWithoutCategory("t1", 7, true);
            rememberHasOrgUnitWithoutCategory("t2", 7, false);

            expect(knownHasOrgUnitWithoutCategory("t1", 7)).toBe(true);
            expect(knownHasOrgUnitWithoutCategory("t2", 7)).toBe(false);
            expect(knownHasOrgUnitWithoutCategory("t3", 7)).toBeUndefined();
            // The access context changed: the user's org units may have too.
            expect(knownHasOrgUnitWithoutCategory("t1", 8)).toBeUndefined();
        });

        it("is forgotten for one tenant once a guest org is brought in, or for all", () => {
            rememberHasOrgUnitWithoutCategory("t1", 7, true);
            rememberHasOrgUnitWithoutCategory("t2", 7, true);

            forgetHasOrgUnitWithoutCategory("t1");
            expect(knownHasOrgUnitWithoutCategory("t1", 7)).toBeUndefined();
            expect(knownHasOrgUnitWithoutCategory("t2", 7)).toBe(true);

            forgetHasOrgUnitWithoutCategory();
            expect(knownHasOrgUnitWithoutCategory("t2", 7)).toBeUndefined();
        });

        /** A question whose answer the test gives. */
        const question = (): { ask: () => Promise<boolean>; answer: (has: boolean) => void } => {
            let answer!: (has: boolean) => void;
            const promise = new Promise<boolean>((resolve) => (answer = resolve));
            return { ask: () => promise, answer };
        };

        it("is asked once for every menu that asks while the question is in flight, and kept", async () => {
            const slow = question();
            const ask = jest.fn(slow.ask);

            const first = askHasOrgUnitWithoutCategory("t1", 7, ask);
            const second = askHasOrgUnitWithoutCategory("t1", 7, ask);
            expect(second).toBe(first);
            expect(ask).toHaveBeenCalledTimes(1);

            slow.answer(true);
            await expect(second).resolves.toBe(true);
            expect(knownHasOrgUnitWithoutCategory("t1", 7)).toBe(true);
        });

        it("is shared by the menus that open after a forget, even when a question from before it lands meanwhile", async () => {
            const stale = question();
            void askHasOrgUnitWithoutCategory("t1", 7, stale.ask);
            forgetHasOrgUnitWithoutCategory("t1");
            const fresh = question();
            const ask = jest.fn(fresh.ask);
            void askHasOrgUnitWithoutCategory("t1", 7, ask);

            // The question from before the forget lands while the one asked after it is still in flight.
            stale.answer(true);
            await Promise.resolve();
            await Promise.resolve();

            // A menu opening now shares the question in flight.
            void askHasOrgUnitWithoutCategory("t1", 7, ask);
            expect(ask).toHaveBeenCalledTimes(1);
        });

        it("keeps the newer answer when a question asked under an older access context lands last", async () => {
            const older = question();
            const olderAnswer = askHasOrgUnitWithoutCategory("t1", 7, older.ask);
            await askHasOrgUnitWithoutCategory("t1", 8, async () => false);
            expect(knownHasOrgUnitWithoutCategory("t1", 8)).toBe(false);

            older.answer(true);
            await olderAnswer;

            expect(knownHasOrgUnitWithoutCategory("t1", 8)).toBe(false);
            expect(knownHasOrgUnitWithoutCategory("t1", 7)).toBeUndefined();
        });

        it("keeps the later of two answers under the same access context", async () => {
            await askHasOrgUnitWithoutCategory("t1", 7, async () => true);
            // A second question under the same context, once the first has landed: a menu that rendered
            // before the first answer landed and whose effect runs after it.
            await askHasOrgUnitWithoutCategory("t1", 7, async () => false);

            expect(knownHasOrgUnitWithoutCategory("t1", 7)).toBe(false);
        });

        it("is asked anew for another tenant, or under another access context", () => {
            const ask = jest.fn(question().ask);

            askHasOrgUnitWithoutCategory("t1", 7, ask);
            askHasOrgUnitWithoutCategory("t2", 7, ask);
            askHasOrgUnitWithoutCategory("t1", 8, ask);

            expect(ask).toHaveBeenCalledTimes(3);
        });

        it("is asked again after a failure, which is not kept", async () => {
            const ask = jest.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue(true);

            await expect(askHasOrgUnitWithoutCategory("t1", 7, ask)).rejects.toThrow("down");
            expect(knownHasOrgUnitWithoutCategory("t1", 7)).toBeUndefined();

            await expect(askHasOrgUnitWithoutCategory("t1", 7, ask)).resolves.toBe(true);
            expect(ask).toHaveBeenCalledTimes(2);
        });

        it.each([
            ["the tenant's", () => forgetHasOrgUnitWithoutCategory("t1")],
            ["every tenant's", () => forgetHasOrgUnitWithoutCategory()],
        ])("is never kept when asked before %s answer was forgotten, and asked anew after", async (_whose, forget) => {
            const late = question();
            const before = askHasOrgUnitWithoutCategory("t1", 7, late.ask);

            forget();
            const ask = jest.fn().mockResolvedValue(false);
            await expect(askHasOrgUnitWithoutCategory("t1", 7, ask)).resolves.toBe(false);
            expect(ask).toHaveBeenCalledTimes(1);

            late.answer(true);
            await expect(before).resolves.toBe(true);
            expect(knownHasOrgUnitWithoutCategory("t1", 7)).toBe(false);
        });

        it("is not kept from a bring-in's 202 until the org unit's space arrives, nor when asked meanwhile", async () => {
            rememberHasOrgUnitWithoutCategory("t1", 7, true);
            rememberHasOrgUnitWithoutCategory("t2", 7, true);

            markBringingIn("t1", "u1", currentSignedInUser());
            expect(knownHasOrgUnitWithoutCategory("t1", 7)).toBeUndefined();
            expect(knownHasOrgUnitWithoutCategory("t2", 7)).toBe(true);

            // The Organization API may still list u1 without a category: the answer is the menu's, and not kept.
            await expect(askHasOrgUnitWithoutCategory("t1", 7, async () => true)).resolves.toBe(true);
            expect(knownHasOrgUnitWithoutCategory("t1", 7)).toBeUndefined();
            rememberHasOrgUnitWithoutCategory("t1", 7, true);
            expect(knownHasOrgUnitWithoutCategory("t1", 7)).toBeUndefined();

            // Asked meanwhile, answered once u1's space is there.
            const late = question();
            const meanwhile = askHasOrgUnitWithoutCategory("t1", 7, late.ask);
            markBroughtIn("t1", "u1");
            late.answer(true);
            await meanwhile;
            expect(knownHasOrgUnitWithoutCategory("t1", 7)).toBeUndefined();

            // Asked after: kept.
            await askHasOrgUnitWithoutCategory("t1", 7, async () => false);
            expect(knownHasOrgUnitWithoutCategory("t1", 7)).toBe(false);
        });

        it("is kept again once every tenant's answer is forgotten, bring-ins and all", () => {
            markBringingIn("t1", "u1", currentSignedInUser());

            forgetHasOrgUnitWithoutCategory();
            rememberHasOrgUnitWithoutCategory("t1", 7, true);

            expect(knownHasOrgUnitWithoutCategory("t1", 7)).toBe(true);
        });

        it("is not kept while another org unit of the tenant is still being brought in", async () => {
            markBringingIn("t1", "u1", currentSignedInUser());
            markBringingIn("t1", "u2", currentSignedInUser());

            markBroughtIn("t1", "u1");
            await askHasOrgUnitWithoutCategory("t1", 7, async () => true);
            expect(knownHasOrgUnitWithoutCategory("t1", 7)).toBeUndefined();

            markBroughtIn("t1", "u2");
            await askHasOrgUnitWithoutCategory("t1", 7, async () => false);
            expect(knownHasOrgUnitWithoutCategory("t1", 7)).toBe(false);
        });

        describe("when the org unit's space never shows it was brought in", () => {
            let now: jest.SpyInstance;
            beforeEach(() => {
                now = jest.spyOn(bringInClock, "now").mockReturnValue(1_000);
            });
            afterEach(() => now.mockRestore());

            it("is not kept for nearly five minutes after the 202", async () => {
                markBringingIn("t1", "u1", currentSignedInUser());

                now.mockReturnValue(1_000 + 5 * 60 * 1000 - 1);
                await askHasOrgUnitWithoutCategory("t1", 7, async () => true);

                expect(knownHasOrgUnitWithoutCategory("t1", 7)).toBeUndefined();
            });

            it("is kept again once the time a bring-in takes is up, but not when asked before", async () => {
                markBringingIn("t1", "u1", currentSignedInUser());

                now.mockReturnValue(1_000 + BRING_IN_SETTLES_AFTER_MS - 1);
                await askHasOrgUnitWithoutCategory("t1", 7, async () => true);
                expect(knownHasOrgUnitWithoutCategory("t1", 7)).toBeUndefined();

                const late = question();
                const before = askHasOrgUnitWithoutCategory("t1", 7, late.ask);
                now.mockReturnValue(1_000 + BRING_IN_SETTLES_AFTER_MS);
                late.answer(true);
                await before;
                expect(knownHasOrgUnitWithoutCategory("t1", 7)).toBeUndefined();

                await askHasOrgUnitWithoutCategory("t1", 7, async () => false);
                expect(knownHasOrgUnitWithoutCategory("t1", 7)).toBe(false);
            });

            it("is kept again five minutes and a millisecond after the 202", async () => {
                markBringingIn("t1", "u1", currentSignedInUser());

                now.mockReturnValue(1_000 + 5 * 60 * 1000 + 1);
                await askHasOrgUnitWithoutCategory("t1", 7, async () => false);

                expect(knownHasOrgUnitWithoutCategory("t1", 7)).toBe(false);
            });
        });

        describe("across sign-ins", () => {
            it("keeps the user's answers and bring-ins when the same user signs in again, as after a soft logout", async () => {
                setSignedInUser("@alice:server");
                rememberHasOrgUnitWithoutCategory("t1", 7, true);
                markBringingIn("t2", "u1", currentSignedInUser());

                setSignedInUser(undefined);
                setSignedInUser("@alice:server");

                expect(knownHasOrgUnitWithoutCategory("t1", 7)).toBe(true);
                // u1 is still being brought in: no answer is kept for t2.
                await askHasOrgUnitWithoutCategory("t2", 8, async () => true);
                expect(knownHasOrgUnitWithoutCategory("t2", 8)).toBeUndefined();
            });

            it("keeps the user's other bring-ins when one of them settles while nobody is signed in", async () => {
                setSignedInUser("@alice:server");
                // Two guest orgs brought in, in two tenants: both 202, and neither space is here yet.
                markBringingIn("t1", "u1", currentSignedInUser());
                markBringingIn("t2", "u2", currentSignedInUser());

                // A soft logout. Her dialog for u1, still open on the client signed out, sees u1's space arrive.
                setSignedInUser(undefined);
                markBroughtIn("t1", "u1");

                // She signs in again. u2 still has no category: the Organization API still lists it.
                setSignedInUser("@alice:server");
                await askHasOrgUnitWithoutCategory("t2", 8, async () => true);
                expect(knownHasOrgUnitWithoutCategory("t2", 8)).toBeUndefined();
            });

            it("forgets them all, bring-ins included, once another user signs in", async () => {
                setSignedInUser("@alice:server");
                rememberHasOrgUnitWithoutCategory("t1", 7, true);
                markBringingIn("t2", "u1", currentSignedInUser());

                setSignedInUser(undefined);
                setSignedInUser("@bob:server");

                expect(knownHasOrgUnitWithoutCategory("t1", 7)).toBeUndefined();
                await askHasOrgUnitWithoutCategory("t2", 8, async () => false);
                expect(knownHasOrgUnitWithoutCategory("t2", 8)).toBe(false);
            });

            it.each([
                ["while nobody is signed in", true],
                ["once the same user signed in again", false],
            ])(
                "keeps nothing from a question that lands after the sign-in it was asked in ended, %s",
                async (_when, whileSignedOut) => {
                    setSignedInUser("@alice:server");
                    const late = question();
                    const before = askHasOrgUnitWithoutCategory("t1", 7, late.ask);
                    const land = async (): Promise<void> => {
                        late.answer(true);
                        await before;
                    };

                    // A soft logout, and the same user again.
                    setSignedInUser(undefined);
                    if (whileSignedOut) await land();
                    setSignedInUser("@alice:server");
                    if (!whileSignedOut) await land();

                    // Her next menu asks again.
                    expect(knownHasOrgUnitWithoutCategory("t1", 7)).toBeUndefined();
                },
            );

            it.each([
                ["while nobody is signed in", true],
                ["once the same user signed in again", false],
            ])("marks a bring-in whose 202 lands after a soft logout, %s", async (_when, whileSignedOut) => {
                setSignedInUser("@alice:server");
                // Her menu offered the option, and she brought u1 in.
                await askHasOrgUnitWithoutCategory("t1", 7, async () => true);
                const sentBy = currentSignedInUser();

                setSignedInUser(undefined);
                if (whileSignedOut) markBringingIn("t1", "u1", sentBy);
                setSignedInUser("@alice:server");
                if (!whileSignedOut) markBringingIn("t1", "u1", sentBy);

                // u1 still has no category: the Organization API still lists it, and no answer is kept.
                await askHasOrgUnitWithoutCategory("t1", 8, async () => true);
                expect(knownHasOrgUnitWithoutCategory("t1", 8)).toBeUndefined();
            });

            it.each([
                ["after she signed out", true],
                ["with no sign-out in between", false],
            ])(
                "marks nothing for a bring-in whose 202 lands once another user signed in, %s",
                async (_when, signedOut) => {
                    setSignedInUser("@alice:server");
                    await askHasOrgUnitWithoutCategory("t1", 7, async () => true);
                    const sentBy = currentSignedInUser();

                    if (signedOut) setSignedInUser(undefined);
                    setSignedInUser("@bob:server");
                    markBringingIn("t1", "u1", sentBy);

                    await askHasOrgUnitWithoutCategory("t1", 8, async () => false);
                    expect(knownHasOrgUnitWithoutCategory("t1", 8)).toBe(false);
                },
            );
        });

        describe("when the wall clock is changed after the 202", () => {
            const MINUTE = 60 * 1000;
            const HOUR = 60 * MINUTE;
            let wall: jest.SpyInstance;
            let monotonic: jest.SpyInstance;
            beforeEach(() => {
                wall = jest.spyOn(Date, "now").mockReturnValue(10 * HOUR);
                monotonic = jest.spyOn(performance, "now").mockReturnValue(1_000);
            });
            afterEach(() => {
                wall.mockRestore();
                monotonic.mockRestore();
            });

            // The five minutes are timed on the monotonic clock, which no one sets.
            it.each([
                ["set back an hour does not stretch the five minutes", -HOUR, 6 * MINUTE, false],
                ["set forward an hour does not shorten them", HOUR, MINUTE, undefined],
            ])("%s", async (_what, setBy, passed, kept) => {
                markBringingIn("t1", "u1", currentSignedInUser());

                wall.mockReturnValue(10 * HOUR + setBy + passed);
                monotonic.mockReturnValue(1_000 + passed);
                await askHasOrgUnitWithoutCategory("t1", 7, async () => false);

                expect(knownHasOrgUnitWithoutCategory("t1", 7)).toBe(kept);
            });
        });
    });

    it("reads a 403 off the error's HTTP status: the user may no longer do this", () => {
        // What the SDK passes on for a 403: the request's own error.
        const forbidden = Object.assign(new Error("Request failed with status code 403"), {
            name: "AxiosError",
            response: { status: 403 },
        });

        expect(isForbidden(forbidden)).toBe(true);
        expect(isForbidden({ response: { status: 403 } })).toBe(true);
        for (const other of [
            Object.assign(new Error("x"), { response: { status: 409 } }),
            Object.assign(new Error("x"), { response: { status: 500 } }),
            Object.assign(new Error("x"), { response: { status: "403" } }),
            new OrgUnitRoomConflictError("MemberOutsideOrgUnit"),
            new Error("down"),
            "403",
            null,
            undefined,
        ]) {
            expect(isForbidden(other)).toBe(false);
        }
    });

    it("reads a conflict's reason, and nothing from any other failure", () => {
        expect(getConflictReason(new OrgUnitRoomConflictError("MemberOutsideOrgUnit"))).toBe("MemberOutsideOrgUnit");
        expect(getConflictReason(new OrgUnitRoomConflictError(undefined))).toBeUndefined();
        expect(getConflictReason(new Error("down"))).toBeNull();
        expect(getConflictReason("down")).toBeNull();
    });

    it("reads a conflict whose reason is not text as one without a reason", () => {
        // A second copy of the SDK, or a changed one, could carry anything there: only text is a reason.
        for (const reason of [42, { reason: "MemberOutsideOrgUnit" }, ["NotARoom"], true, null]) {
            const conflict = Object.assign(new Error("conflict"), { name: "OrgUnitRoomConflictError", reason });
            expect(getConflictReason(conflict)).toBeUndefined();
        }
    });

    it("logs a failure as its message, never with the request that carries the token", () => {
        const failure = Object.assign(new Error("Request failed with status code 403"), {
            name: "AxiosError",
            config: { headers: { Authorization: "Bearer verji-token" } },
        });

        expect(describeError(failure)).toBe("AxiosError: Request failed with status code 403");
        expect(describeError("plain")).toBe("plain");
    });
});
