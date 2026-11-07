// CUE constraints for every protobuf type in temporary_redis.proto.
//
// These pin the invariants the TypeScript parse boundary already enforces, so a
// change in one is visible as a diff against the other. There is deliberately
// no field here that could hold credential material: the REST token exists for
// one hop inside the driver and appears downstream only as a locator.
package temporary_redis

import "list"

#Uuid4: =~"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"

// A locator, never a value. Only the schemes `parseSecretRef` registers.
#SecretRefLocator: =~"^(vault|azure-kv|aws-sm|gcp-sm|op|infisical|hobo-secret|hobo-token)://[A-Za-z0-9._~-]+/[A-Za-z0-9._~/-]+(#[A-Za-z0-9._-]+)?$"

// A bare hostname on the provider's own domain: no scheme, no userinfo, no
// port suffix. Host checks are by suffix on `.upstash.io` and by equality on
// `upstash.com`, so a lookalike such as `upstash.io.attacker.example` fails.
#UpstashHostname: =~"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.upstash\\.io$"

#MetricsUrlPrefix: "https://upstash.com/start-redis/metrics/"
#ConsoleUrlPrefix: "https://upstash.com/start-redis/console/"

// The provider states a calendar day, not an instant.
#CalendarDate: =~"^\\d{4}-\\d{2}-\\d{2}$"

#Instant: =~"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{3})?Z$"

// The zero slot of the protobuf enum has no spelling here: a state this
// package cannot name is a contract change, not a fifth admissible state.
#UpstashClaimState: "unclaimed" | "claimed-pending-rotation" | "complete" | "expired"

#UpstashProviderFactKind: "provider.upstash.database.provisioned" |
	"provider.upstash.database.adopted" |
	"provider.upstash.claim.pending-rotation" |
	"provider.upstash.claim.completed" |
	"provider.upstash.lease.expired"

#StartRedisDatabase: {
	contract: "upstash.start-redis.markdown/v1" | "upstash.start-redis.markdown/v2"

	// Also the idempotency key: `createDatabase` refuses a response whose id
	// differs from the key it sent, because a provider that ignores the
	// header would otherwise mint a second database on every retry.
	database_id: #Uuid4

	rest_endpoint_host: #UpstashHostname
	rest_endpoint_url:  "https://" + rest_endpoint_host
	expires_on:         #CalendarDate
	expires_at_ms:      int & >0
	expires_at_iso:     #Instant
	expires_raw:        =~"^\\d{1,3} days? from creation\\.?$"
	stated_ttl_days:    int & >0 & <=999
	metrics_url:        #MetricsUrlPrefix + database_id

	// The claim ceremony lives here, and it must address the same database as
	// the id above: a console link pointing elsewhere is a claim hijack.
	console_url: #ConsoleUrlPrefix + database_id

	// The parser hands the token to the driver as a separate value and it is
	// deposited immediately; no record derived from this one may carry it.
	token_present: true
}

// Documentation, not observation. Kept apart from the provider-reported
// expiry instant so a plan can say what to expect before the call without the
// two ever being read as the same fact.
#UpstashUnclaimedLimits: {
	documented_expiry_hours: 72
	transport:               "https-rest"
}

#UpstashNonSecretEndpoint: {
	host:      #UpstashHostname
	port:      443
	tls:       true
	transport: "https-rest"
}

#UpstashClaimAction: {
	id:          "upstash.claim.transfer-to-account" | "upstash.claim.rotate-rest-token"
	kind:        "human-ceremony" | "owner-console"
	description: string & !=""
	blocking:    true
	completed:   bool
	url?:        =~"^https://upstash\\.com/start-redis/console/"
}

#UpstashClaimPlan: {
	strategy:      "resource-claim"
	boundary:      "resource"
	resource_kind: "upstash-redis-database"
	atomicity:     "single-resource"
	claim_url:     =~"^https://upstash\\.com/start-redis/console/"
	state:         #UpstashClaimState

	// Two ceremonies, both blocking: the human transfer, then the owner
	// resetting the REST token. Neither can be skipped into "complete".
	actions: [...#UpstashClaimAction] & list.MinItems(2)

	// The provider has no state that distinguishes a claimed database from an
	// unclaimed one, so "complete" is reachable only from attestations — and
	// only once every blocking action is done.
	if state == "complete" {
		actions: [...{completed: true}]
	}
}

#UpstashTemporaryRedis: {
	schema_version: "hobo.provider-upstash.temporary-redis/v1"
	definition_id:  "upstash.temporary-redis/v1"
	provider_id:    "upstash"
	resource_ref:   string & !=""
	database_id:    #Uuid4

	rest_endpoint_host:      #UpstashHostname
	rest_endpoint_url:       "https://" + rest_endpoint_host
	credential_ref?:         #SecretRefLocator
	rest_url_ref?:           #SecretRefLocator
	redis_protocol_url_ref?: #SecretRefLocator

	expires_at_ms:  int & >0
	expires_at_iso: #Instant
	expires_raw:    string & !=""

	stated_ttl_days: int & >0 & <=999

	// Never a local timer: the instant above comes from the provider's own
	// answer, and the published 72 hours is carried separately in `limits`.
	expiry_source: "provider-reported"

	observed_at_ms: int & >0
	claim:          #UpstashClaimPlan
	metrics_url:    #MetricsUrlPrefix + database_id
	limits:         #UpstashUnclaimedLimits
	adopted:        bool

	// A record is "expired" exactly when nobody attested a claim and the
	// provider's instant has already passed; an unclaimed record that is past
	// its instant may not call itself live.
	if claim.state == "unclaimed" {
		_live: true & (expires_at_ms > observed_at_ms)
	}
}

#UpstashClaimSummary: {
	state:     #UpstashClaimState
	boundary:  "resource"
	atomicity: "single-resource"
	claim_ref: #SecretRefLocator

	// Only the blocking actions still outstanding, so "the ceremony happened"
	// cannot be read as "nobody holds a residual credential".
	blocking_action_ids: [...("upstash.claim.transfer-to-account" | "upstash.claim.rotate-rest-token")]

	if state == "complete" {
		blocking_action_ids: []
	}
}

#UpstashProvisionReceipt: {
	schema_version:      "hobo.provider-upstash.receipt/v2"
	definition_id:       "upstash.temporary-redis/v1"
	provider_id:         "upstash"
	resource_ref:        =~"^claimable:[0-9a-f]{64}$"
	opaque_physical_id:  =~"^claimable:[0-9a-f]{64}$"
	native_identity_ref: #SecretRefLocator
	endpoint:            #UpstashNonSecretEndpoint

	credential_ref?:         #SecretRefLocator
	rest_url_ref?:           #SecretRefLocator
	redis_protocol_url_ref?: #SecretRefLocator

	expires_at_iso:  #Instant
	expires_at_ms:   int & >0
	stated_ttl_days: int & >0 & <=999
	expiry_source:   "provider-reported"
	observed_at_ms:  int & >0
	adopted:         bool
	claim:           #UpstashClaimSummary
	limits:          #UpstashUnclaimedLimits

	binding_profiles: [...("binding.redis-rest/v1")] & list.MinItems(1)

	// Empty by construction: this surface documents no export path, and an
	// advertised migration profile that fails at execution time is worse than
	// none at all.
	migration_profiles: []

	// There is no delete API on the anonymous surface. Reporting anything else
	// would be claiming a teardown this package cannot perform.
	teardown: "expiry-only"
}

#UpstashProviderFact: {
	schema_version:      "hobo.provider-upstash.fact/v2"
	kind:                #UpstashProviderFactKind
	occurred_at_ms:      int & >0
	resource_ref:        =~"^claimable:[0-9a-f]{64}$"
	opaque_physical_id:  =~"^claimable:[0-9a-f]{64}$"
	native_identity_ref: #SecretRefLocator

	// Non-secret scalars only — the wire form flattens them to strings. A
	// locator may appear; material may not, and `assertNoCredentialMaterial`
	// re-scans the serialized fact before it is returned.
	detail: [string]: string | number | bool
}
