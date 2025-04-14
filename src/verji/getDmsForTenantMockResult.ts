export enum Tenant {
    JULEHJUL = "e5cfd639-f45b-4ab4-a772-706c1eba96f3",
    I_AM_PC = "175bfad6-3f37-498a-b2fb-c2ca2c4983f7"
}

type MockData = {
    [tenantId: string]: {
        [userId: string]: string[]
    }
}

const mockData: MockData = {
    "e5cfd639-f45b-4ab4-a772-706c1eba96f3": {
        "@corpoadmin:staging.verji.app": ["!hurjlcjdstRXDEAyEA:staging.verji.app"],
        "@vsys:staging.verji.app": ["!HANubAjJbZgyvNzQmx:staging.verji.app"],
        "@badgerboy:staging.verji.app": ["!itopocOBPOuVcmosaQ:staging.verji.app"],
        "@jtsg1jh-dpde:staging.verji.app": ["!IteDdJBVxBfdfwgfhq:staging.verji.app"],
        "@jtsemp1jh-eiuq:staging.verji.app": ["!nfccYssaOSvtXwMyCS:staging.verji.app"],
        "@jtsguest1nospace-umbg:staging.verji.app": ["!CdYBZAWylIqHTRnjyd:staging.verji.app"],
        "@jtsguest2nospace-rzon:staging.verji.app": ["!QOAStGwiuNCyPRyGRy:staging.verji.app"]

    },
    "175bfad6-3f37-498a-b2fb-c2ca2c4983f7": {
        "@jtsonlyguest-gxht:staging.verji.app": ["!TrrBmWoKzgCuUcbZsA:staging.verji.app"]
    }
}

export const getDmsForTenantMockResult = (tenantId?: string ): MockData["tenantId"] => {
    let result = {} as MockData["tenantId"]
    switch(tenantId){
        case Tenant.JULEHJUL:
            // Everyone except user: Only Guest
            result = mockData[tenantId]
            break;
        case Tenant.I_AM_PC:
            result = mockData[tenantId] // user Only Guest
            break;
        default: 
            break;
    }

    return result;
}