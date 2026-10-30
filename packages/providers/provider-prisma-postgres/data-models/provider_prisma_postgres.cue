// CUE constraints for every protobuf type in provider_prisma_postgres.proto.
// The invariants that matter here are the ones a credential leak or a
// misplaced trust assumption would violate: refs are locators, endpoints are
// bare hostnames, the claim host is the official one, and the expiry source is
// never allowed to claim to be provider-attested.

package provider_prisma_postgres

import "list"

#SecretRefLocator: =~"^(vault|azure-kv|aws-sm|gcp-sm|op|infisical|hobo-secret|hobo-token)://[A-Za-z0-9._~-]+/[A-Za-z0-9._~/-]+(#[A-Za-z0-9._-]+)?$"

#BareHostname: =~"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$"

#ClaimUrl: =~"^https://create-db\\.prisma\\.io(/[^?#]*)?\\?([^#]*&)?projectID=proj_[A-Za-z0-9_-]{1,120}"

#ProjectId: =~"^proj_[A-Za-z0-9_-]{1,120}$"

#Instant: =~"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{3})?Z$"

#Region: "ap-northeast-1" | "ap-southeast-1" | "eu-central-1" | "eu-west-3" | "us-east-1" | "us-west-1"

// The CLI derives the deletion instant from the machine's own clock, so this
// field may never be set to "provider-reported" anywhere in this package.
#ExpirySource: "cli-local-clock"

// HoBo's claim lifecycle. There is no `claiming` member: the workspace
// transfer is a browser ceremony this package cannot observe midway, so the
// record either has an attestation or it does not. `complete` is reachable
// only after the owner-rotation attestation as well.
#PrismaClaimState: "unclaimed" | "claimed-pending-rotation" | "complete" | "expired"

// How a record was read. `json` is the pinned CLI's machine-readable document,
// `human-v1` the documented pretty output, and `local-journal` an observation
// replayed from this package's own journal — there is no read-by-id API, so an
// observation must say which of the three it came from.
#PrismaOutputMode: "json" | "human-v1" | "local-journal"

#PrismaCreateDocument: {
	project_id:                #ProjectId
	claim_url:                 #ClaimUrl
	deletion_date_ms:          int & >0
	region:                    #Region
	name:                      =~"^[\\x20-\\x7e]{1,128}$"
	connection_string_present: bool
	output_mode:               #PrismaOutputMode
}

#PrismaNonSecretEndpoint: {
	host:  #BareHostname & "db.prisma.io"
	port?: uint32 & >0 & <=65535
	path?: =~"^/[^\\x00-\\x1f]{0,128}$"
	tls:   true
}

#PrismaClaimAction: {
	id:          =~"^prisma\\.claim\\.[a-z-]+$"
	kind:        "human-ceremony" | "owner-api"
	description: string & !=""
	blocking:    bool
	completed:   bool
	url?:        #ClaimUrl
}

#PrismaAssociatedResourceRef: {
	schema_version:             "hobo.provider-prisma-postgres.associated-resource/v1"
	kind:                       "prisma-postgres-project"
	provider_id:                "prisma"
	definition_id:              "prisma.claimable-postgres/v1"
	project_id:                 #ProjectId
	claim_url:                  #ClaimUrl
	claim_host:                 "create-db.prisma.io"
	standalone_claim_supported: true
	requires_workspace:         true
	bundle_strategy:            "associated-resource"
	region:                     #Region
	database_name:              string & !=""
	expires_at_iso:             #Instant
	expiry_source:              #ExpirySource
}

#PrismaClaimPlan: {
	strategy:      "resource-claim"
	boundary:      "resource"
	resource_kind: "prisma-postgres-project"
	atomicity:     "single-resource"
	claim_url:     #ClaimUrl
	state:         #PrismaClaimState

	// Two ceremonies: the workspace transfer, then the owner credential
	// rotation. Both blocking, so neither can be skipped into "complete".
	actions: [...#PrismaClaimAction] & list.MinItems(2)

	if state == "complete" {
		actions: [...{blocking: false} | {completed: true}]
	}

	associated_resource: #PrismaAssociatedResourceRef
}

#Ttl: "30m" | =~"^(1[0-9]|2[0-4]|[1-9])h$"

// Every argv element, in one place: no whitespace, no shell metacharacter, no
// control character, and nothing credential-shaped. A value that would need
// quoting is refused rather than quoted.
#ArgvElement: =~"^[^\\s;&|`$><'\"\\\\\\x00-\\x1f]+$" & !~"(?i)postgres(ql)?://" & !~"(?i)password[=:]"

#PrismaProvisionOperation: {
	schema_version:         "hobo.provider-prisma-postgres.provision-operation/v1"
	kind:                   "provision"
	definition_id:          "prisma.claimable-postgres/v1"
	provider_id:            "prisma"
	compiler_ref:           "compile.prisma.claimable-postgres/v1"
	executor_ref:           "execute.prisma.claimable-postgres/v1"
	bootstrap_strategy_ref: "bootstrap.prisma.create-db/v1"
	claim_strategy_ref:     "claim.prisma.database/v1"
	resource_ref:           string & !=""
	idempotency_key:        =~"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$"
	region:                 #Region
	argv: [...#ArgvElement] & list.MinItems(4)
	timeout_ms:           int & >0 & <=900000
	max_output_bytes:     int & >0 & <=1048576
	output_mode:          "json"
	documented_ttl_hours: 24
	requested_ttl?:       #Ttl
	produces_binding_profiles: [...("binding.postgresql/v1")]
	expected_secret_purpose: "connection-string"

	// The pinned version must appear verbatim, and `latest` must not. A plan
	// that resolves a version at run time is not a reviewable plan.
	argv: list.Contains("create-db@1.2.1")
	argv: [...(!~"@latest$")]
}

#PrismaClaimSummary: {
	state:     #PrismaClaimState
	boundary:  "resource"
	atomicity: "single-resource"
	claim_ref: #SecretRefLocator

	// Only the blocking actions still outstanding, so "the transfer happened"
	// cannot be read as "nobody holds a residual credential".
	blocking_action_ids: [...(=~"^prisma\\.claim\\.[a-z-]+$")]

	if state == "complete" {
		blocking_action_ids: []
	}
}

#PrismaProvisionReceipt: {
	schema_version:       "hobo.provider-prisma-postgres.receipt/v2"
	definition_id:        "prisma.claimable-postgres/v1"
	provider_id:          "prisma"
	resource_ref:         =~"^claimable:[a-f0-9]{64}$"
	database_name:        string & !=""
	region:               #Region
	credential_ref?:      #SecretRefLocator
	expires_at_iso:       #Instant
	expires_at_ms:        int & >0
	expiry_source:        #ExpirySource
	documented_ttl_hours: 24
	observed_at_ms:       int & >0
	adopted:              bool
	output_mode:          #PrismaOutputMode
	claim:                #PrismaClaimSummary
	binding_profiles: [...("binding.postgresql/v1")] & list.MinItems(1)

	// pg_dump only: logical replication is not documented for this tier.
	migration_profiles: [...("migration.postgres.pg-dump/v1")]
	opaque_physical_id:      =~"^claimable:[a-f0-9]{64}$"
	native_identity_ref:     #SecretRefLocator
	endpoint_ref:            #SecretRefLocator
	binding_ref?:            #SecretRefLocator
	associated_resource_ref: #SecretRefLocator
}

#PrismaProviderFact: {
	kind:                "provider.prisma.database.provisioned" | "provider.prisma.database.adopted" | "provider.prisma.claim.pending-rotation" | "provider.prisma.claim.completed" | "provider.prisma.lease.expired"
	occurred_at_ms:      int & >0
	resource_ref:        =~"^claimable:[a-f0-9]{64}$"
	opaque_physical_id:  =~"^claimable:[a-f0-9]{64}$"
	native_identity_ref: #SecretRefLocator
	detail: [string]: string | number | bool
}
