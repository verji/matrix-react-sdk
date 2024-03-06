/*
Copyright 2023 Mikhail Aheichyk
Copyright 2023 Nordeck IT + Consulting GmbH.

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

import React  from "react";
import { screen } from "@testing-library/react";

import HomePage from "../../../src/components/structures/HomePage";
// import { UIFeature } from "../../../src/settings/UIFeature"
import SettingsStore from "../../../src/settings/SettingsStore";
import { _tDom } from "../../../src/languageHandler";
import {
    // createTestClient,
    getMockClientWithEventEmitter,
    // makeBeaconInfoEvent,
    mockClientMethodsEvents,
    mockClientMethodsUser,
} from "../../test-utils";
// import { MatrixClient } from "../../../../matrix-js-sdk/src/matrix";
// import MatrixClientContext, { useMatrixClientContext } from "../../../src/contexts/MatrixClientContext";
// import { stubClient } from "../../test-utils";
import { MatrixClientPeg } from "../../../src/MatrixClientPeg";
import renderer from "react-test-renderer";


jest.mock("../../../src/customisations/helpers/UIComponents", () => ({
    shouldShowComponent: jest.fn(),
}));

//jest.mock("../../../src/settings/SettingsStore/SettingsStore", () => ({
//    SettingsStore.getValue(): jest.fn(),
//}));


describe("HomePage", () => {
    // let client: MatrixClient;

    // stubClient();
    // client = MatrixClientPeg.safeGet();

    // const cli = useContext(MatrixClientContext);

    // mocked(client.getUserId).mockReturnValue("1231");
    //mocked(MatrixClient.getUserId()).mockReturnValue("1231");

    const userId = "@me:here";
    const client = getMockClientWithEventEmitter({
        ...mockClientMethodsUser(userId),
        ...mockClientMethodsEvents(),
        getAccountData: jest.fn(),
        isUserIgnored: jest.fn().mockReturnValue(false),
        isRoomEncrypted: jest.fn().mockReturnValue(false),
        getRoom: jest.fn(),
        getClientWellKnown: jest.fn().mockReturnValue({}),
        supportsThreads: jest.fn().mockReturnValue(true),
        getUserId: jest.fn(),
    });

    // jest.spyOn(MatrixClient, "getUserId").mockReturnValue("client");
    // jest.spyOn(SettingsStore, "getValue").mockReturnValue(true);
    jest.spyOn(MatrixClientPeg, "safeGet").mockReturnValue(client);

    // jest.mock('useContext')
    // jest.mock('MatrixClient')
    // jest.mock(MatrixClient)
    // jest.mock('../../../src/contexts/MatrixClientContext')

    // jest.mock('../../../node_modules/@testing-library/react-hooks/src/__tests__/useContext', () => { return client })
    // const uc = require('../../../node_modules/@testing-library/react-hooks/src/__tests__/usecontext')
    // uc.mockImplementation(() => client)

    // jest.fn(mcc => useContext(MatrixClientContext));

    client.getUserId.mockReturnValue('123');

    it("shows the Welcome screen buttons when feature is true", () => {
        jest.spyOn(SettingsStore, "getValue").mockReturnValue(true);

        // jest.mock('../../../node_modules/@testing-library/react-hooks/src/__tests__/useContext', () => { return  { MatrixClientContext: client } })

        client.getUserId.mockReturnValue('123');
        // const component = renderer.create(renderComponent()).toJSON();
        const component = renderer.create(<HomePage justRegistered={ false } />).toJSON();

        expect(component).toMatchSnapshot();

        // expect(screen.findByRole("AccessibleButton")).toBeInTheDocument();
        expect(screen.queryByText("Explore Public Rooms")); //.toBeInTheDocument();
        // expect(screen.getByRole("div", { name: /Explore Public Rooms/i })).toBeInTheDocument();
    });
    it("does not show the Welcome screen buttons when feature is false", () => {
        jest.spyOn(SettingsStore, "getValue").mockReturnValue(false);

        // jest.mock('../../../node_modules/@testing-library/react-hooks/src/__tests__/useContext', () => { return  { MatrixClientContext: client } })

        client.getUserId.mockReturnValue('123');
        // const component = renderer.create(renderComponent()).toJSON();
        const component = renderer.create(<HomePage justRegistered={ false } />).toJSON();

        expect(component).toMatchSnapshot();

        // expect(screen.findByRole("AccessibleButton")).toBeInTheDocument();
        expect(screen.queryByText("Explore Public Rooms")).not.toBeInTheDocument();
    });
    /*
    it("does not show buttons on HomePage when disabled by UIFeature customisations", () => {
        //mocked(SettingsStore.getValue(UIFeature.HomePageButtons)).mockReturnValue(false);
        renderComponent();
        expect(screen.queryByRole("AccessibleButton")).not.toBeInTheDocument();
        //expect(screen.findAllByText({_tDom("onboarding|create_room")})).not.toBeInTheDocument();
        //expect(screen.findAllByText("Test")).not.toBeInTheDocument();
        //expect(screen.queryByRole("button", { name: "Explore rooms" })).not.toBeInTheDocument();
    });

    it("does show buttons on HomePage when enabled by UIFeature customisations", () => {
        //mocked(SettingsStore.getValue(UIFeature.HomePageButtons)).mockReturnValue(true);
        renderComponent();
        expect(screen.queryByRole("AccessibleButton")).toBeInTheDocument();
    });
    */
});
