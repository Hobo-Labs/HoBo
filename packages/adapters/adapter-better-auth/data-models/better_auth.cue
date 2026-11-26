package adapter_better_auth

// Constraints for the Better Auth issuer adapter records.
//
// These are patterns, not documentation. The load-bearing ones:
//   - #SigningSecretRef only admits a scheme://authority/path locator in a
//     registered custody scheme, and forbids "@" so embedded userinfo cannot
//     smuggle a credential through a field that claims to be a reference;
//   - #DataProfileId keeps the auth tables inside the governed data plane
//     rather than a private store the migration gates cannot see;
//   - claims_mapping_version is required on every mapped principal, so a
//     principal always names the ADR-0073 mapping rules that produced it;
//   - roles is constrained to lowercase slugs, which is what makes "deduped
//     and sorted" a checkable property instead of a convention.

#AuthAdapterHostingKind: "AUTH_ADAPTER_HOSTING_KIND_SELF_HOSTED" |
	"AUTH_ADAPTER_HOSTING_KIND_HOSTED"

// scheme://authority/path in a registered custody scheme, with no userinfo.
#SigningSecretRef: =~"^(aws-sm|azure-kv|gcp-sm|hobo-secret|hobo-token|infisical|op|vault)://[^@\\s]+/[^@\\s]+$"

// ADR-0151 capability-profile grammar, narrowed to the data primitive family.
#DataProfileId: =~"^data\\.[a-z0-9-]+(\\.[a-z0-9-]+)*/v[1-9][0-9]*$"

// Absolute, lowercase, traversal-free mount path with no trailing slash.
#BasePath: =~"^(/[a-z0-9][a-z0-9._~-]*)+$"

#PortId:            =~"^hobo:[a-z0-9-]+(/[a-z0-9-]+)*$"
#RoleSlug:          =~"^[a-z][a-z0-9._:-]{0,63}$"
#SocialProviderId:  =~"^[a-z][a-z0-9-]*$"
#ClaimsMappingVersion: =~"^better-auth-claims/v[1-9][0-9]*$"

#AuthAdapterDescriptorRecord: {
	contract:               "hobo.auth-adapter/v1"
	id:                     "better-auth"
	display_name:           string & !=""
	hosting:                #AuthAdapterHostingKind
	// Exactly the three composed ports, sorted. The bundle owns no private
	// infrastructure, and a Camp that cannot satisfy one of them must refuse
	// the adapter at plan time rather than fail at first login — so the set is
	// closed here rather than left open for an adapter to widen quietly.
	required_ports: [
		#PortId & "hobo:data/relational",
		#PortId & "hobo:http",
		#PortId & "hobo:secrets",
	]
	claims_mapping_version: #ClaimsMappingVersion
	supports_organizations: bool
}

#BetterAuthConfigRecord: {
	contract:                   "hobo.auth-adapter/v1"
	adapter_id:                 "better-auth"
	base_path:                  #BasePath
	signing_secret_ref:         #SigningSecretRef
	database_profile:           #DataProfileId
	email_and_password_enabled: bool
	social_providers:           [...#SocialProviderId]
	organizations_enabled:      bool
}

#MappedPrincipalRecord: {
	subject:                string & !=""
	issuer:                 =~"^https?://[^@\\s/]+(/[^\\s]*)?$"
	email?:                 =~"^[^@\\s]+@[^@\\s.]+(\\.[^@\\s.]+)+$"
	organization_id?:       string & !=""
	roles:                  [...#RoleSlug]
	claims_mapping_version: #ClaimsMappingVersion
}

#BetterAuthRefusalRecord: {
	code:    =~"^BETTER_AUTH_[A-Z_]+$"
	message: string & !=""
	// A refusal that cannot say what to change is not a refusal, it is a wall.
	remediation: string & !=""
}
