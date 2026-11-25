package packs

#PackId: =~"^pack\\.better-auth/v1$"
#AdapterId: "better-auth"
#PortId: =~"^hobo:[a-z0-9-]+(/[a-z0-9-]+)*$"
#ClaimsMappingVersion: =~"^better-auth-claims/v[1-9][0-9]*$"
#SigningSecretRef: =~"^(aws-sm|azure-kv|gcp-sm|hobo-secret|hobo-token|infisical|op|vault)://[^@\\s]+/[^@\\s]+$"
#BindleName: =~"^[a-z][a-z0-9_-]{0,63}$"
#BasePath: =~"^(/[a-z0-9][a-z0-9._~-]*)+$"
#DataProfileId: =~"^data\\.[a-z0-9-]+(?:\\.[a-z0-9-]+)*/v[1-9][0-9]*$"
#SocialProviderId: =~"^[a-z][a-z0-9-]*$"

#BetterAuthBundlePortRefsRecord: {
	relational_bindle: #BindleName
	http_bindle:         #BindleName
	signing_secret_ref:  #SigningSecretRef
}

#BetterAuthParsedConfigRecord: {
	contract:                   "hobo.auth-adapter/v1"
	adapter_id:                 #AdapterId
	base_path:                  #BasePath
	secret_ref:                 #SigningSecretRef
	database_profile:           #DataProfileId
	email_and_password_enabled: bool
	social_providers:           [...#SocialProviderId]
	organizations_enabled:      bool
}

#BetterAuthBundlePlanRecord: {
	pack_id:                #PackId
	descriptor_id:          #AdapterId
	claims_mapping_version: #ClaimsMappingVersion
	required_ports: [
		#PortId & "hobo:data/relational",
		#PortId & "hobo:http",
		#PortId & "hobo:secrets",
	]
	adapter_id:     #AdapterId
	base_path:      #BasePath
	route_pattern:  string & != ""
	ports:          #BetterAuthBundlePortRefsRecord
	parsed_config:  #BetterAuthParsedConfigRecord
}

#BetterAuthRelationalMigrationRecord: {
	pack_id:                  #PackId
	relational_bindle:        #BindleName
	database_profile:         =~"^data\\.(relational|postgres)/v[0-9]+$"
	migration_plan_contract:  "hobo.migration-plan/v1"
	migration_plan_digest:    =~"^sha256:[0-9a-f]{64}$"
	expand_step_count:        int & >=0
}