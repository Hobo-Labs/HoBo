package packs

#PackId: =~"^pack\\.better-auth/v1$"
#AdapterId: "better-auth"
#ClaimsMappingVersion: =~"^better-auth-claims/v[0-9]+$"
#SecretRef: =~"^(vault|azure-kv|aws-sm|gcp-sm|op|infisical|hobo-secret|hobo-token)://[^@?/]+/[^@?]+$"
#BindleName: =~"^[a-z][a-z0-9_-]{0,63}$"
#BasePath: =~"^/[a-z0-9][a-z0-9._~-]*(/[a-z0-9][a-z0-9._~-]*)*$"

#BetterAuthBundlePortRefsRecord: {
	relational_bindle: #BindleName
	http_bindle:         #BindleName
	signing_secret_ref:  #SecretRef
}

#BetterAuthBundlePlanRecord: {
	pack_id:                #PackId
	descriptor_id:          #AdapterId
	claims_mapping_version: #ClaimsMappingVersion
	required_ports:         [...=~"^hobo:[a-z/]+$"] & [string, string, string]
	adapter_id:             #AdapterId
	base_path:              #BasePath
	route_pattern:          string & != ""
	ports:                  #BetterAuthBundlePortRefsRecord
}

#BetterAuthRelationalMigrationRecord: {
	pack_id:                  #PackId
	relational_bindle:        #BindleName
	database_profile:         =~"^data\\.(relational|postgres)/v[0-9]+$"
	migration_plan_contract:  "hobo.migration-plan/v1"
	migration_plan_digest:    =~"^sha256:[0-9a-f]{64}$"
	expand_step_count:        int & >=0
}

#IsoDateTime: =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"

#BetterAuthSigningSecretWireRecord: {
	secret_ref:       #SecretRef
	secret_scheme:    =~"^[a-z0-9-]+$"
	secrets_port_id:  string & != ""
	resolved_at_iso:  #IsoDateTime
}