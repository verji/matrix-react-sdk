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

import { MatrixClientPeg } from "../../MatrixClientPeg";
import SettingController from "./SettingController";
import { SettingLevel } from "../SettingLevel";
import { ModuleRunner } from "../../modules/ModuleRunner";
import { UIFeature } from "../UIFeature";

/**
 * Controller will delegate override decision to an extension 
 */
export default class DelegateToExtensionController extends SettingController {

    settingName: string;

    constructor(settingName: UIFeature){
        super();
        this.settingName = settingName;
    }

    public getValueOverride(
        level: SettingLevel,
        roomId: string,
        calculatedValue: any,
        calculatedAtLevel: SettingLevel | null,
    ): any {

        var settingsExtension = ModuleRunner.instance.extensions.experimental;

        var client = MatrixClientPeg.get();

        var result = settingsExtension?.experimentalMethod({
            settingName: this.settingName,
            userId: client?.getUserId(),
            level: level,
            roomId: roomId,
            calculatedValue: calculatedValue,
            calculatedAtLevel: calculatedAtLevel
        });

        return result.value; // no override
    }

    public get settingDisabled(): boolean {
        return false;
    }   
}
