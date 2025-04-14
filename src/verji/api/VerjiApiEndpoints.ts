

///////////////////////////////////////
//     Verji AccessControl Api       //
// https://itopsacl.{env}.verji.app  //
///////////////////////////////////////

const acl = {
    get: {
        tenants: 'api/v{version}/acl/tenants',
        all_tenants_with_specified_module: '/api/v{version}/license/module/{modulename}/tenants',
    }
}

///////////////////////////////////////
//    Verji IdentityServer Api       //
//   https://id.{env}.verji.app      //
///////////////////////////////////////

const identityServer = {
    get: {
        verjiAccessToken: '/connect/token'
    }
}

export const VerjiApiEndpoints = {
    acl,
    identityServer
}
