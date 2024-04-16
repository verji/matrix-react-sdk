/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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
import { fireEvent, render, RenderResult, screen } from "@testing-library/react";
import { MatrixClient, Room, EventType, MatrixEvent } from "matrix-js-sdk/src/matrix";
import { mocked } from "jest-mock";

import GeneralRoomSettingsTab from "../../../../../../src/components/views/settings/tabs/room/GeneralRoomSettingsTab";
import { createTestClient, mkEvent, mkStubRoom, stubClient } from "../../../../../test-utils";
import dis from "../../../../../../src/dispatcher/dispatcher";
// import { Action } from "../../../../../../src/dispatcher/actions";
import { MatrixClientPeg } from "../../../../../../src/MatrixClientPeg";
import SettingsStore from "../../../../../../src/settings/SettingsStore";
import { UIFeature } from  "../../../../../../src/settings/UIFeature";
import AliasSettings from "../../../../../../src/components/views/room_settings/AliasSettings";

jest.mock("../../../../../../src/dispatcher/dispatcher");

describe("GeneralRoomSettingsTab", () => {
    const roomId = "!room:example.com";
    let cli: MatrixClient;
    let room: Room;

    const renderTab = (): RenderResult => {
        return render(<GeneralRoomSettingsTab room={room} />);
    };

    const mockClient = createTestClient();

    // mocked(this.context).mockReturnValue(mockClient);


    beforeEach(() => {
        stubClient();
        cli = MatrixClientPeg.safeGet();
        room = mkStubRoom(roomId, "test room", cli);
        mocked(cli.getRoom).mockReturnValue(room);
        mocked(dis.dispatch).mockReset();
        mocked(room.findPredecessor).mockImplementation((msc3946: boolean) =>
            msc3946
                ? { roomId: "old_room_id_via_predecessor", viaServers: ["one.example.com", "two.example.com"] }
                : { roomId: "old_room_id", eventId: "tombstone_event_id" },
        );
        // jest.spyOn(cli,"getDomain").mockReturnValue("example.com")
        mocked(cli.getDomain).mockReturnValue("example.com");
    });

    it("should not display local addresses when feature is false", () => {
        jest.spyOn(SettingsStore, "getValue").mockImplementation((name: string) => {
            if (name = UIFeature.RoomSettingsAlias) return false;
            return true;
        });

        const tab = renderTab();
        // expect(tab.findByText("Local Addresses")).toBeFalsy();
        expect(tab.queryByText("Local Addresses")).toBeFalsy();    
    });
    it("should fail when feature is true", () => {
        jest.spyOn(SettingsStore, "getValue").mockImplementation((name: string) => {
            if (name = UIFeature.RoomSettingsAlias) return true;
            return true;
        });
        // jest.spyOn(AliasSettings.context, "context").mockImplementation((name: string) => {

        let errMsg ="";
        const tab = renderTab();
        try {
          renderTab();
        } catch(e:unknown){
            errMsg = e.message;
        }
        const actMess = "Cannot read properties of null (reading 'getDomain')"
        tab.getByText("Local Addresses");
        // expect(errMsg).toEqual(actMess);
    });
    
    // it("displays message when room cannot federate", () => {
    //     const createEvent = new MatrixEvent({
    //         sender: "@a:b.com",
    //         type: EventType.RoomCreate,
    //         content: { "m.federate": false },
    //         room_id: room.roomId,
    //         state_key: "",
    //     });
    //     jest.spyOn(room.currentState, "getStateEvents").mockImplementation((type) =>
    //         type === EventType.RoomCreate ? createEvent : null,
    //     );

    //     renderTab();
    //     expect(screen.getByText("This room is not accessible by remote Matrix servers")).toBeInTheDocument();
    // });
});
