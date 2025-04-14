import { Room } from "matrix-js-sdk/src/models/room"
import { getDmsForTenantMockResult } from "./getDmsForTenantMockResult"
import { MatrixClient } from "matrix-js-sdk/src/client"
import { IConfigOptions } from "../IConfigOptions"
import { fetchTenants } from "./api/verji-api"


export type VerjiConfig = IConfigOptions & {verjiDefaultApiTimeout: number, verjiLinkOnboardingUrl: string, vmxAccountUrl: string, verjiAclUrl: string, verjiIdUrl: string, portalLocation: string}

export async function getDmsForTenant(tenantId: string, client: MatrixClient): Promise<Room[]> {

    // const token = await getVerjiToken()
    const tenantResult = await fetchTenants() // Simulate a backend call to see if token is accepted
    console.log("[VERJI] - attempt fetchTenants to see if token valid: ", tenantResult)
    let rooms = [] as Room[]

    // We simulate that we must have a succesful tenants call inorder to return the mocked dm's result (Should be replaced by the real enpoint when it's ready)
    if(tenantResult){
        const result = getDmsForTenantMockResult(tenantId)

        // Flatten the result into a single array of Room Id's
        const roomIds: string[] = Object.values(result).flatMap(user => 
            Object.values(user).flat()
        )
        

        roomIds.forEach(roomId => {
            const room = client.getRoom(roomId)
            if(room){
                rooms.push(room)
            }
        })
    }
    

    return rooms
}

