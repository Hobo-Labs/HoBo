package authadapter

#SigningSecretRef: =~"^(aws-sm|azure-kv|gcp-sm|hobo-secret|hobo-token|infisical|op|vault)://[^@\\s]+/[^@\\s]+$"

#DataProfileId: =~"^data\\.[a-z0-9-]+(?:\\.[a-z0-9-]+)*/v[1-9][0-9]*$"

#BasePath: =~"^(/[a-z0-9][a-z0-9._~-]*)+$"

#SocialProviderId: =~"^[a-z][a-z0-9-]*$"

#ClaimsMappingVersion: =~"^better-auth-claims/v[1-9][0-9]*$"

#BetterAuthConfigRecord: {
	contract:                   "hobo.auth-adapter/v1"
	adapter_id:                 "better-auth"
	base_path:                  #BasePath
	secret_ref:                 #SigningSecretRef
	database_profile:           #DataProfileId
	email_and_password_enabled: bool
	social_providers:           [...#SocialProviderId]
	organizations_enabled:      bool
}