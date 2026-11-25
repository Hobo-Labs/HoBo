package authadapter

#ClaimsMappingVersion: =~"^better-auth-claims/v[0-9]+$"
#SecretRef: =~"^(vault|azure-kv|aws-sm|gcp-sm|op|infisical|hobo-secret|hobo-token)://[^@?/]+/[^@?]+$"
#BasePath: =~"^/[a-z0-9][a-z0-9._~-]*(/[a-z0-9][a-z0-9._~-]*)*$"

#BetterAuthConfigRecord: {
	contract:         "hobo.auth-adapter/v1"
	adapter_id:       "better-auth"
	base_path:          #BasePath
	secret_ref:         #SecretRef
	database_profile: =~"^data\\.[a-z0-9-]+(?:\\.[a-z0-9-]+)*/v[1-9][0-9]*$"
}