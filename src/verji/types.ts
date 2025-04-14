import { IConfigOptions } from "../IConfigOptions"

export type VerjiConfig = IConfigOptions & {verjiDefaultApiTimeout: number, verjiLinkOnboardingUrl: string, vmxAccountUrl: string, verjiAclUrl: string, verjiIdUrl: string, portalLocation: string}

export type VerjiAccessToken = {
    access_token: string,
    expires_in: number,
    token_type: string,
    scope: string
}