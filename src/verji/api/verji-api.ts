import { MatrixClientPeg } from "../../MatrixClientPeg"
import axios from "axios"
import { VerjiSessionStorage } from "../store/VerjiSessionStorage"
import { VerjiAccessToken, VerjiConfig } from "../types"
import { VerjiApiEndpoints } from "./VerjiApiEndpoints"
import SdkConfig from "../../SdkConfig"


export enum ReplaceParams {
    personId = '{personId}',
    mxId = '{mxId}',
    aclDomain = '{acldomain}',
    tenantId = '{tenantid}',
    email = '{email}',
    onboardingId = '{onboardingid}',
    modulename = '{modulename}',
    version = '{version}',
}

// replaces all parameters in url (from replaceParam enum) with values from params object
export function replaceParamsInUrl(urlTemplate: string, params: { [key: string]: string }): string {
    let url = urlTemplate;
    Object.keys(params).forEach((key) => {
        url = url.replace(key, params[key]);
    });
    return url;
}
const getAclApi = () => axios.create({
    baseURL: (SdkConfig.get() as VerjiConfig).verjiAclUrl,
    headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    },
    timeout: 10000
});
const getIdServerApi = () => axios.create({
    baseURL: (SdkConfig.get() as VerjiConfig).verjiIdUrl,
    headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
        //'Access-Control-Request-Method': '*',
        // 'Accept': 'application/json',
    },
});
// Only for simulation purposes
export const fetchTenants = async (): Promise<any[]> => {
    const accessToken = await getVerjiToken();
    const config = {
        headers: { Authorization: `Bearer ${accessToken.access_token}` },
    };
    try {
        const url = replaceParamsInUrl(VerjiApiEndpoints.acl.get.tenants, {[ReplaceParams.version]: '1.1'}) //'/api/v1.1/license/module/Onboarding/tenants'

        const response = await getAclApi().get(url, config);
        return response.data;
    } catch (error) {
        console.error('Error fetching user by ID:', error);
        throw error;
    }
};

export const getVerjiToken = async (): Promise<VerjiAccessToken> => {

    if(VerjiSessionStorage.get().hasValidVerjiAccessToken()){

        console.log("[Verji.getVerjiToken] - Found a valid Verji Access Token in session storage.")
        return VerjiSessionStorage.get().getVerjiAccessToken()! // We can safely expect the return is not null, because we check hasValidVerjiAccessToken before returning
        
    }

    console.log("[Verji.getVerjiToken] - No valid Verji Access Token found in session storage, fetching...")

    const macaroon = MatrixClientPeg.safeGet().getAccessToken()

    if(!macaroon) {
        console.error("[Verji.getVerjiToken] - Unable to get matrix access token(macaroon), because the matrix client is null, or the token is missing")
        throw new Error("Unable to get Matrix Access Token.")
    }
    const body = {
        client_id: 'vmx-front-end',
        grant_type: 'synapse_macaroon',
        audience: 'vmx-account',
        scope: 'openid profile vmx-account-api',
        macaroon: macaroon,
    }

    try {
        console.warn("[VERJI] - Fetching token from IdServer - If you see multiple log entries of this warning, something is not right")
        const response = await getIdServerApi().post(VerjiApiEndpoints.identityServer.get.verjiAccessToken, body);
        VerjiSessionStorage.get().setVerjiAccessToken(response.data)
        return response.data;
    } catch (error) {
        console.error('Error fetching Verji Token:', error);
        throw error;
    }
}
