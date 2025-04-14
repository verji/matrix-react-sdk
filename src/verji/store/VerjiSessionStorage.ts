import { VerjiAccessToken } from "../types";


enum VerjiSessionStorageKeys {
    AccessToken = "verji_access_token",
    AccessTokenExpirationTime = "verji_access_token_epiration_time"
}

export class VerjiSessionStorage {

    private static instance: VerjiSessionStorage

    private constructor(){}

    public static get(){
        if(!VerjiSessionStorage.instance){
            VerjiSessionStorage.instance = new VerjiSessionStorage();
        }

        return VerjiSessionStorage.instance;
    }

    public getVerjiAccessToken(): VerjiAccessToken | null{
        let accessToken = sessionStorage.getItem(VerjiSessionStorageKeys.AccessToken)
        if (accessToken){
            return JSON.parse(accessToken) as VerjiAccessToken
        }

        return null;
    }

    public setVerjiAccessToken(accessToken: VerjiAccessToken){
        console.log("[VerjiSessionStorage] - Setting Access Token: ", accessToken)
        const expirationTime = Date.now() + accessToken.expires_in * 1000
        sessionStorage.setItem(VerjiSessionStorageKeys.AccessToken, JSON.stringify(accessToken))

        // Update expiration time in session storage
        this.setVerjiAccessTokenExpirationTime(expirationTime)
    }

    public getVerjiAccessTokenExpirationTime(): number{
        return Number(sessionStorage.getItem(VerjiSessionStorageKeys.AccessTokenExpirationTime))
    }

    public setVerjiAccessTokenExpirationTime(time: number){
        sessionStorage.setItem(VerjiSessionStorageKeys.AccessTokenExpirationTime, JSON.stringify(time))
    }

    public hasValidVerjiAccessToken(): boolean{
        const token = this.getVerjiAccessToken()

        // If we don't have a access token, we return false
        if(!token){
            return false
        }
        // return true if token we have has not expired
        return Date.now() < this.getVerjiAccessTokenExpirationTime()
    }
}