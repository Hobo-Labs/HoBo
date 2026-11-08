package data_models

#ScopeKind: "bindle" | "camp" | "yard" | "junction"

#PlacementObjective: "min-cost" | "pinned"

#PlacementPolicy: {
	id:         string & !=""
	scope_kind: #ScopeKind
	objective:  #PlacementObjective
	// Dependent constraint: a pinned objective must name its provider.
	if objective == "pinned" {
		pinned_provider_id: string & !=""
	}
	pinned_provider_id?: string
	allowed_providers?: [...string & !=""]
	denied_providers?: [...string & !=""]
	allowed_regions?: [...string & !=""]
	require_explicit_camps: bool | *false
}

#BillingPolicy: {
	quota:          string & !=""
	quota_used:     int & >=0
	quota_limit:    int & >=0
	budget_usd:     number & >=0
	spend_cap_usd:  number & >=0
	budget_unlimited: bool | *false
	spend_cap_unlimited: bool | *false
	// Cross-field invariant: consumed quota never exceeds the limit.
	quota_used: <=quota_limit
}

#DeliveryPolicy: {
	engine:    "argo" | "in-proc"
	sync_mode: "auto" | "manual"
	prune:     bool | *false
	// Dependent constraint: the Argo engine needs a GitOps repo and namespace.
	if engine == "argo" {
		gitops_repo:           string & !=""
		destination_namespace: string & !=""
	}
	gitops_repo?:           string
	destination_namespace?: string
}

#ConnectorKind: "github-app" | "pulumi" | "azure" | "vercel" | "cloudflare" | "custom"

#ConnectorConfig: {
	id:           string & !=""
	kind:         #ConnectorKind
	display_name: string & !=""
	settings: {[string]: string}
	// A reference into the token broker / secret store, never a raw secret.
	credential_ref?: string
	enabled:         bool | *true
}

#BrokerPolicySet: {
	schema_version: "hobo.broker/v1"
	broker_id:      string & !=""
	placement_policies: [...#PlacementPolicy]
	billing:  #BillingPolicy
	delivery: #DeliveryPolicy
	required_connector_kinds?: [...#ConnectorKind]
}

#TopologyScope: {
	bindle_id:    string & !=""
	camp_id?:     string & !=""
	yard_id?:     string & !=""
	junction_id?: string & !=""
}

#ResourceRequirement: {
	resource_id: string & !=""
	port:        string & !=""
	features?: [...string & !=""]
	region?: string & !=""
}

#BrokerRequest: {
	schema_version: "hobo.broker/v1"
	request_id:     string & !=""
	scope:          #TopologyScope
	requirements: [...#ResourceRequirement] & [_, ...]
	spend_estimate_usd: number & >=0
	guest?:             #GuestResolutionInput
}

#Digest: string & =~"^sha256:[0-9a-f]{64}$"
#Instant: string & =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$"

#BootstrapClass: "public-anonymous" | "proof-of-work" | "capability-token" |
	"agent-self-registration" | "sponsor-backed" | "wallet-funded" |
	"local-accountless" | "preauthenticated-agent" | "user-owned"

#Realization: "native" | "pack" | "bridge"

#ClaimAtomicity: "single-resource" | "provider-bundled" | "best-effort-saga"

#CleanupPolicy: "delete" | "retain-temporarily" | "transfer" | "migrate"

#CreatorAuthorityAfterClaim: "absent" | "reauthorization-required" | "rotatable" |
	"retained" | "unknown"

#GuestResolutionInput: {
	recipe_id:       string & !=""
	topology_digest: #Digest
	offer_digest:    #Digest
	consent_digest:  #Digest
	bootstrap_class: #BootstrapClass
	// A sponsor-backed request must name a non-zero cap; an anonymous one
	// costs the sponsor nothing and must not carry a budget.
	sponsor_cost_cap_minor_units: int & >=0
	max_claim_actions:            uint & <=16
	if bootstrap_class == "sponsor-backed" {
		sponsor_cost_cap_minor_units: >0
	}
	if bootstrap_class == "public-anonymous" {
		sponsor_cost_cap_minor_units: 0
	}
}

#GuestPlacementEvidence: {
	resource_id:   string & !=""
	definition_id: string & !=""
	realization:   #Realization
	runtime_model: string & !=""
	capability_profile_refs: [...string & !=""] & [_, ...]
	binding_profile_refs?: [...string & !=""]
	connectivity_ref?:     string & !=""
	bootstrap_class:       #BootstrapClass
	claim_mode:            string & !=""
	// A placement whose creator authority is unknown cannot be presented as
	// owner-controlled; the resolver must have gated on this already.
	creator_authority_after_claim: #CreatorAuthorityAfterClaim
	// Widening off native must be attributable to a binding or pack, so a
	// bridge placement has to say what it bridges through.
	if realization == "bridge" {
		connectivity_ref: string & !=""
	}
}

#GuestResolutionEvidence: {
	recipe_id:       string & !=""
	topology_digest: #Digest
	offer_digest:    #Digest
	consent_digest:  #Digest
	guest_lease_id:  string & !=""
	lease_expires_at?: #Instant
	claim_bundle_id:   string & !=""
	claim_atomicity:   #ClaimAtomicity
	claim_action_count: uint
	earliest_claim_deadline?: #Instant
	placements: [...#GuestPlacementEvidence] & [_, ...]
	trust_evidence_refs: [...string & !=""] & [_, ...]
	conformance_refs: [...string & !=""] & [_, ...]
	source_disclosures?: [...string & !=""]
	credential_custody?: [...string & !=""]
	widening_disclosures?: [...string & !=""]
	sponsor_cost_cap_minor_units: int & >=0
	cleanup_policy:               #CleanupPolicy
	// A bundle with human actions must carry a deadline; one with none must
	// not imply a ceremony that will never arrive.
	if claim_action_count > 0 {
		earliest_claim_deadline: #Instant
	}
	// Single-resource atomicity describes exactly one claimable placement.
	if claim_atomicity == "single-resource" {
		claim_action_count: <=1
	}
}

#PlacementDecision: {
	resource_id:    string & !=""
	provider_id:    string & !=""
	definition_id:  string & !=""
	region:         string & !=""
	sku:            string & !=""
	unit:           string & !=""
	marginal_price: string & !=""
}

#ResolutionReceipt: {
	schema_version:      "hobo.broker/v1"
	request_id:          string & !=""
	broker_id:           string & !=""
	catalog_hash:        string & =~"^sha256:"
	policy_hash:         string & =~"^sha256:"
	placement_policy_id: string & !=""
	placements: [...#PlacementDecision] & [_, ...]
	station_id?: string
	rail_hash?:  string
	guest?:      #GuestResolutionEvidence
}

#RejectionPlane: "policy" | "contracts" | "billing" | "placement" | "connectors" | "residency"

#RejectionReason: {
	plane:   #RejectionPlane
	code:    string & !=""
	message: string & !=""
}

#ResolutionRejection: {
	schema_version: "hobo.broker/v1"
	request_id:     string & !=""
	broker_id:      string & !=""
	policy_hash:    string & =~"^sha256:"
	reasons: [...#RejectionReason] & [_, ...]
	station_id?: string
	rail_hash?:  string
}

#BrokerEnvironment: {
	environment_id: string & !=""
	approved_providers: [...string & !=""]
	catalog_hash?: string & =~"^sha256:"
	approved:      bool | *false
	// Dependent constraint: an approved environment records its approver.
	if approved {
		approved_by: string & !=""
	}
	approved_by?: string
}

#ResolutionSignature: {
	algorithm:      "ed25519"
	public_key_pem: string & =~"BEGIN PUBLIC KEY"
	signature:      string & !=""
	payload_digest: string & =~"^sha256:"
}

#ScaleDirection: "up" | "down" | "zero"

#ScaleDirective: {
	resource_id: string & !=""
	direction:   #ScaleDirection
	replicas:    int & >=0
	// Dependent constraint: scale-to-zero means zero replicas.
	if direction == "zero" {
		replicas: 0
	}
}
