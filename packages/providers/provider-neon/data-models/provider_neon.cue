// CUE constraints for every protobuf type in provider_neon.proto, so the
// architecture guard can confirm the boundary shapes are bounded at parse
// time. The invariants that matter here are the ones a credential leak would
// violate: refs are locators, endpoints are bare hostnames, expiry is the
// provider's instant.

package provider_neon

import "list"

#SecretRefLocator: =~"^(vault|azure-kv|aws-sm|gcp-sm|op|infisical|hobo-secret|hobo-token)://[A-Za-z0-9._~-]+/[A-Za-z0-9._~/-]+(#[A-Za-z0-9._-]+)?$"

#BareHostname: =~"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$"

// Neon's own status vocabulary, verbatim as the API returns it. The protobuf
// enum's zero slot (`NEON_DATABASE_STATUS_UNSPECIFIED`) has no wire spelling
// here on purpose: a response whose status this package cannot name is a
// contract change, not a fourth admissible state.
#NeonDatabaseStatus: "UNCLAIMED" | "CLAIMING" | "CLAIMED"

// HoBo's claim lifecycle, which is deliberately *not* the provider's. Neon has
// no state between `CLAIMED` and a rotated owner credential, so
// `claimed-pending-rotation` exists only here, and `complete` is reachable
// only through an attested rotation.
#NeonClaimState: "unclaimed" | "claiming" | "claimed-pending-rotation" | "complete" | "expired"

#NeonDatabaseRecord: {
	database_id:               =~"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
	status:                    #NeonDatabaseStatus
	neon_project_id:           =~"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
	claim_url:                 =~"^https://neon\\.new/"
	expires_at_ms:             int & >0
	created_at_ms:             int & >0
	updated_at_ms:             int & >0
	connection_string_present: bool

	// A lease that expires before it exists is a contract change, not a lease.
	_expiry_after_creation: true & (expires_at_ms > created_at_ms)
}

#NeonNonSecretEndpoint: {
	host:  #BareHostname
	port?: uint32 & >0 & <=65535
	path?: =~"^/[^\\x00-\\x1f]{0,128}$"
	tls:   true
}

// The direct endpoint is the pooled one with the pooler segment removed, so
// both name the same database; only the host differs.
#NeonReceiptEndpoints: {
	pooled: #NeonNonSecretEndpoint
	direct: #NeonNonSecretEndpoint
}

#NeonClaimAction: {
	id:          =~"^neon\\.claim\\.[a-z-]+$"
	kind:        "human-ceremony" | "owner-api"
	description: string & !=""
	blocking:    bool
	completed:   bool
	url?:        =~"^https://"
}

#NeonClaimPlan: {
	strategy:      "resource-claim"
	boundary:      "resource"
	resource_kind: "neon-project-database"
	atomicity:     "single-resource"
	claim_url:     =~"^https://neon\\.new/"
	state:         #NeonClaimState
	actions: [...#NeonClaimAction] & list.MinItems(2)

	// The claim is only complete when every blocking action is done. A
	// provider-side CLAIMED with an unrotated credential is not complete.
	if state == "complete" {
		actions: [...{blocking: false} | {completed: true}]
	}
}

#NeonClaimSummary: {
	state:     #NeonClaimState
	boundary:  "resource"
	atomicity: "single-resource"
	claim_ref: #SecretRefLocator

	// Only the blocking actions still outstanding, so "the ceremony happened"
	// cannot be read as "nobody holds a residual credential".
	blocking_action_ids: [...(=~"^neon\\.claim\\.[a-z-]+$")]

	if state == "complete" {
		blocking_action_ids: []
	}
}

// Documented, not observed. The published unclaimed-tier figures, kept apart
// from the provider-reported expiry so a plan can say what to expect before
// the call without the two ever being read as the same fact.
#NeonUnclaimedLimits: {
	max_storage_bytes:      104857600
	max_transfer_bytes:     1073741824
	branches:               false
	region:                 "aws-us-east-2"
	postgres_major_version: 17
}

#NeonProvisionReceipt: {
	schema_version:         "hobo.provider-neon.receipt/v2"
	definition_id:          "neon.claimable-postgres/v1"
	provider_id:            "neon"
	resource_ref:           =~"^claimable:[a-f0-9]{64}$"
	provider_status:        #NeonDatabaseStatus
	database_name:          string & !=""
	credential_ref?:        #SecretRefLocator
	direct_credential_ref?: #SecretRefLocator
	expires_at_iso:         =~"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{3})?Z$"
	expires_at_ms:          int & >0
	expiry_source:          "provider-reported"
	observed_at_ms:         int & >0
	adopted:                bool
	claim:                  #NeonClaimSummary
	limits:                 #NeonUnclaimedLimits
	binding_profiles: [...("binding.postgresql/v1" | "binding.neon-serverless/v1")] & list.MinItems(1)
	migration_profiles: [...("migration.postgres.pg-dump/v1" | "migration.postgres.logical-copy/v1")]
	opaque_physical_id:  =~"^claimable:[a-f0-9]{64}$"
	native_identity_ref: #SecretRefLocator
	endpoint_ref:        #SecretRefLocator
	binding_ref?:        #SecretRefLocator
	native_project_ref:  #SecretRefLocator
}

#NeonProviderFact: {
	kind:                "provider.neon.database.provisioned" | "provider.neon.database.adopted" | "provider.neon.database.observed" | "provider.neon.claim.pending-rotation" | "provider.neon.claim.completed" | "provider.neon.lease.expired"
	occurred_at_ms:      int & >0
	resource_ref:        =~"^claimable:[a-f0-9]{64}$"
	opaque_physical_id:  =~"^claimable:[a-f0-9]{64}$"
	native_identity_ref: #SecretRefLocator
	detail: [string]: string | number | bool
}
