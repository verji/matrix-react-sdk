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

import fetchMock from "fetch-mock-jest";
import { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk/src/matrix";

import nb from "../../../src/i18n/strings/nb_NO.json";
import { setLanguage } from "../../../src/languageHandler";
import { getOrgUnitCategoryDisplayName } from "../../../src/stores/verji/verjiSpaceNames";
import { getMockClientWithEventEmitter, mockClientMethodsUser } from "../../test-utils";

const USER = "@alice:domain.org";

/** A real Room with real state, as in VerjiSpaceContext-test: Verji events key on their own type. */
const makeSpace = (client: MatrixClient, events: Record<string, object>, isSpace = true): Room => {
    const room = new Room("!space:domain.org", client, USER);
    jest.spyOn(room, "isSpaceRoom").mockReturnValue(isSpace);
    room.currentState.setStateEvents(
        Object.entries(events).map(
            ([type, content]) =>
                new MatrixEvent({ type, state_key: type, room_id: room.roomId, sender: USER, content }),
        ),
    );
    return room;
};

const TENANT_INFO = { "app.verji.tenant_info": { tenant_id: "tenant-1" } };
const PARENT = { "app.verji.canonical_parent_space": { canonical_parent_space_id: "!canonical-root:domain.org" } };
const ORG_UNIT = { "app.verji.org_unit_info": { org_unit_id: "org-a" } };

describe("getOrgUnitCategoryDisplayName", () => {
    let client: MatrixClient;

    beforeAll(() => {
        fetchMock
            .get("/i18n/languages.json", { "en": "en_EN.json", "nb-no": "nb_NO.json" }, { overwriteRoutes: true })
            .get("end:nb_NO.json", nb);
    });

    beforeEach(() => {
        client = getMockClientWithEventEmitter(mockClientMethodsUser(USER));
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        await setLanguage("en");
    });

    describe("an OrgUnitCategory space", () => {
        const category = (): Room => makeSpace(client, { ...TENANT_INFO, ...PARENT });

        it.each([
            ["Guest Organizations", "Gjesteorganisasjoner"],
            ["Cases", "Saker"],
            ["Projects", "Prosjekter"],
        ])("translates %s into Norwegian", async (stored, translated) => {
            await setLanguage("nb-no");
            expect(getOrgUnitCategoryDisplayName(category(), stored)).toBe(translated);
        });

        it("shows the English name in English", () => {
            expect(getOrgUnitCategoryDisplayName(category(), "Guest Organizations")).toBe("Guest Organizations");
        });

        it("leaves a name with no translation to the stored name", async () => {
            await setLanguage("nb-no");
            expect(getOrgUnitCategoryDisplayName(category(), "Suppliers")).toBeNull();
        });

        it("matches the stored name exactly", async () => {
            await setLanguage("nb-no");
            expect(getOrgUnitCategoryDisplayName(category(), "guest organizations")).toBeNull();
            expect(getOrgUnitCategoryDisplayName(category(), "constructor")).toBeNull();
        });
    });

    describe("any other space keeps its name", () => {
        beforeEach(async () => {
            await setLanguage("nb-no");
        });

        it("an OrgUnit (guest organization) named like a category", () => {
            const orgUnit = makeSpace(client, { ...TENANT_INFO, ...PARENT, ...ORG_UNIT });
            expect(getOrgUnitCategoryDisplayName(orgUnit, "Projects")).toBeNull();
        });

        it("a tenant root", () => {
            const root = makeSpace(client, TENANT_INFO);
            expect(getOrgUnitCategoryDisplayName(root, "Guest Organizations")).toBeNull();
        });

        it("a space outside Verji's hierarchy", () => {
            expect(getOrgUnitCategoryDisplayName(makeSpace(client, PARENT), "Cases")).toBeNull();
        });

        it("a room that is not a space", () => {
            const room = makeSpace(client, { ...TENANT_INFO, ...PARENT }, false);
            expect(getOrgUnitCategoryDisplayName(room, "Cases")).toBeNull();
        });
    });
});
