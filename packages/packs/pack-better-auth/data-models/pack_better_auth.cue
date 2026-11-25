package packs

#PackId: =~"^pack\\.better-auth/v1$"
#AdapterId: "better-auth"
#ClaimsMappingVersion: =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
#SecretRef: =~"^(vault|azure-kv|aws-sm|gcp-sm|op|infisical|hobo-secret|hobo-token)://[^@?]+/[^@?]+$"
#BindleName: =~"^[a-z][a-z0-9-]{0,62}$"
#BasePath: =~"^/[A-Za-z0-9._/-]+$"

#BetterAuthBundlePortRefsRecord: {
	relational_bindle: #BindleName
	http_bindle:         #BindleName
	signing_secret_ref:  #SecretRef
}

#BetterAuthBundlePlanRecord: {
	pack_id:                 #PackId
	descriptor_id:           #AdapterId
	claims_mapping_version:  #ClaimsMappingVersion
	required_ports:          [...=~"^hobo:[a-z/]+$"] & [string, ...]
	adapter_id:              #AdapterId
	base_path:                 #BasePath
	route_pattern:             string & != ""
	ports:                     #BetterAuthBundlePortRefsRecord
}