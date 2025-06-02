/*
Copyright 2020-2022 The Matrix.org Foundation C.I.C.

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

import { useEffect, useState } from "react";
import * as React from "react";

import { useInitialSyncComplete } from "../../../hooks/useIsInitialSyncComplete";
import SdkConfig from "../../../SdkConfig";
import AutoHideScrollbar from "../../structures/AutoHideScrollbar";
import { useMatrixClientContext } from "../../../contexts/MatrixClientContext";

interface Props {
    appId: string;
}

enum AppId {
    signing = "verji-signing",
    portal = "verji-portal"
}


const ANIMATION_DURATION = 2800;
export function VerjiAppPage({ appId = "" }: Props): JSX.Element {
    const cli = useMatrixClientContext();
    const config = SdkConfig.get();

    console.log("VERJI APP PAGE - AppId: ", appId)
    const initialSyncComplete = useInitialSyncComplete();
    const [showList, setShowList] = useState<boolean>(false);
    useEffect(() => {
        if (initialSyncComplete) {
            const handler = window.setTimeout(() => {
                setShowList(true);
            }, ANIMATION_DURATION);
            return () => {
                clearTimeout(handler);
            };
        } else {
            setShowList(false);
        }
    }, [initialSyncComplete, setShowList]);


    switch (appId) {
        case AppId.signing:
            return <iframe 
                src="https://verjiweb.staging.verji.app/signing-orders-overview"
                title="Verji-Signing"
                style={{width: '100%', height: '100%', border: 'none'}} 
            />
            break;
        case AppId.portal:
             return <iframe 
                src="https://portal.staging.verji.app/"
                title="Verji-Portal"
                style={{width: '100%', height: '100%', border: 'none'}} 
            />
            break;
        default:
            break;
    }

    return (
        <AutoHideScrollbar className="mx_UserOnboardingPage">
            <div>Error Loading App</div>
        </AutoHideScrollbar>
    );
}
