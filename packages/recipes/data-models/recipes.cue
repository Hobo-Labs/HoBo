package data_models

#Digest: =~"^sha256:[0-9a-f]{64}$"

#RecipeId: =~"^recipe\\.[a-z0-9]+(-[a-z0-9]+)*(\\.[a-z0-9]+(-[a-z0-9]+)*)*/v[1-9][0-9]*$"

#RecipeLease: {
	bootstrap_class:        string & !=""
	cleanup_policy:         "delete" | "retain-until-provider-expiry" | "transfer" | "migrate"
	renewable:              bool
	claim_by_ms_from_start: int & >0
}

#RecipeYard: {
	yard_id:       string & !=""
	provider_id:   string & !=""
	resource_only: bool
	sponsored:     bool
	lease:         #RecipeLease
}

#RecipeClaimExpectation: {
	mode:                          string & !=""
	atomicity:                     "single-resource" | "provider-bundled" | "best-effort-saga"
	action_count:                  int & >=0 & <=32
	creator_authority_after_claim: "absent" | "reauthorization-required" | "rotatable" | "retained" | "unknown"
	// A claim that transfers nothing must not carry human actions or a deadline.
	if mode == "none" {
		action_count: 0
	}
	deadline_ms_from_start?: int & >0
	post_claim_actions: [...string]
	// Above zero human actions, the recipe must state the window those
	// actions have to happen in.
	_actionsNeedDeadline: true & (action_count == 0 | deadline_ms_from_start != _|_)
}

#RecipePlacement: {
	placement_id:          string & !=""
	yard_id:               string & !=""
	primitive:             string & !=""
	capability_ref:        string & !=""
	satisfies_profile_id:  string & !=""
	product_definition_id: string & !=""
	claim:                 #RecipeClaimExpectation
	camp_id?:              string & !=""
	runtime_model?:        string & !=""
}

#RecipeConnectivityChoice: {
	connectivity_implementation_id: string & !=""
	binding_profile_ref:            string & !=""
}

#RecipeConnectivityEdge: {
	edge_id:           string & !=""
	from_placement_id: string & !=""
	to_placement_id:   string & !=""
	primary:           #RecipeConnectivityChoice
	fallbacks: [...#RecipeConnectivityChoice]
	// An edge from a placement to itself is a cycle, not connectivity.
	_noSelfEdge: true & (from_placement_id != to_placement_id)
}

#RecipeSemantics: {
	claim_count:        int & >=0
	claim_kind:         "provider-native" | "sponsor-migration"
	persistence:        "persistent" | "ephemeral"
	realtime:           "websocket" | "polling" | "none"
	credential_custody: "secret-ref" | "plaintext"
	bootstrap:          "public-anonymous" | "sponsored"
	// Sponsored transfer is only coherent when the bootstrap is sponsored.
	if claim_kind == "sponsor-migration" {
		bootstrap: "sponsored"
	}
}

#RecipeBootstrapExpectation: {
	sponsored_cost_cap_minor_units: int & >=0
	source_disclosure:              "public-source" | "private-source" | "not-applicable"
	offer_ttl_ms:                   int & >0
}

#SolutionRecipe: {
	schema_version: "hobo.solution-recipe/v1"
	id:             #RecipeId
	display_name:   string & !=""
	description:    string & !=""
	yards: [...#RecipeYard] & [_, ...]
	placements: [...#RecipePlacement] & [_, ...]
	edges: [...#RecipeConnectivityEdge]
	delivers:  #RecipeSemantics
	bootstrap: #RecipeBootstrapExpectation
	// The delivered claim count is a fold of the placements, not a separate
	// promise: a recipe cannot advertise one claim and then require three.
	_claimCountMatchesPlacements: true & (delivers.claim_count ==
		len([for placement in placements if placement.claim.mode != "none" {placement}]))
	// A sponsor cost cap without a sponsored Yard is exposure nobody owns.
	_sponsorCapNeedsSponsoredYard: true & (bootstrap.sponsored_cost_cap_minor_units == 0 |
		len([for yard in yards if yard.sponsored {yard}]) > 0)
}

#Realization: "native" | "pack" | "bridge"

#ResolvedResource: {
	resource_ref:          string & !=""
	placement_id:          string & !=""
	capability_ref:        string & !=""
	primitive:             string & !=""
	satisfies_profile_id:  string & !=""
	product_definition_id: string & !=""
	realization:           #Realization
	runtime_model?:        string & !=""
	produces_binding_profiles: [...string]
}

#ResolvedCamp: {
	camp_id:  string & !=""
	camp_ref: string & !=""
	resources: [...#ResolvedResource]
}

#ResolvedYard: {
	yard_id:       string & !=""
	yard_ref:      string & !=""
	provider_id:   string & !=""
	resource_only: bool
	sponsored:     bool
	regions: [...string]
	camps: [...#ResolvedCamp]
	resources: [...#ResolvedResource]
	// A resource-only Yard holds its resources directly; anything else places
	// its workloads in Camps. Fabricating an empty Camp would add a second
	// ownership boundary that nothing asked for.
	_resourceOnlyHasNoCamps: true & (!resource_only | len(camps) == 0)
	_campedYardHoldsNoLooseResources: true & (resource_only | len(resources) == 0)
}

#ResolvedBinding: {
	edge_id:                        string & !=""
	from_resource_ref:              string & !=""
	to_resource_ref:                string & !=""
	binding_profile_ref:            string & !=""
	connectivity_implementation_id: string & !=""
	cross_yard:                     bool
	used_fallback:                  bool
	_noSelfBinding: true & (from_resource_ref != to_resource_ref)
}

#ResolvedTopology: {
	schema_version: "hobo.resolved-topology/v1"
	recipe_id:      #RecipeId
	junction_ref:   string & !=""
	yards: [...#ResolvedYard] & [_, ...]
	bindings: [...#ResolvedBinding]
}

#OfferPlacement: {
	placement_id:          string & !=""
	yard_id:               string & !=""
	provider_id:           string & !=""
	primitive:             string & !=""
	capability_ref:        string & !=""
	satisfies_profile_id:  string & !=""
	product_definition_id: string & !=""
	realization:           #Realization
	camp_id?:              string & !=""
}

#OfferProvider: {
	provider_id:   string & !=""
	sponsored:     bool
	resource_only: bool
}

#OfferClaimItem: {
	claim_id:                      string & !=""
	subject_ref:                   string & !=""
	provider_id:                   string & !=""
	mode:                          string & !=""
	action_count:                  int & >=0 & <=32
	creator_authority_after_claim: "absent" | "reauthorization-required" | "rotatable" | "retained" | "unknown"
	deadline_ms?:                  int & >0
	// A claim that costs a human an action has to say when it stops being
	// possible: an actionable claim with no deadline can never be shown to
	// have lapsed, so the lease behind it can never be safely reaped.
	_actionsNeedDeadline: true & (action_count == 0 | deadline_ms != _|_)
}

#OfferClaimSummary: {
	action_count:   int & >=0 & <=32
	provider_count: int & >=0
	atomicity:      "single-resource" | "provider-bundled" | "best-effort-saga"
	items: [...#OfferClaimItem]
	earliest_deadline_ms?: int & >0
	// The summary is a fold of the items, never an independent assertion:
	// one provider per item bounds the distinct-provider count.
	_providerCountFolded: true & (provider_count <= len(items))
	// A bundle spanning more than one resource cannot call itself a
	// single-resource claim.
	_singleResourceIsSingle: true & (atomicity != "single-resource" | len(items) <= 1)
	_actionsNeedDeadline:    true & (action_count == 0 | earliest_deadline_ms != _|_)
}

#OfferGuestLease: {
	lease_id:        string & !=""
	yard_id:         string & !=""
	bootstrap_class: string & !=""
	cleanup_policy:  "delete" | "retain-until-provider-expiry" | "transfer" | "migrate"
	renewable:       bool
	claim_by_ms:     int & >0
}

#OfferPortability: {
	provider_count: int & >=1
	export_supported_placements: [...string]
	export_missing_placements: [...string]
	migration_profiles: [...string]
}

#WideningKind: "bootstrap.public-anonymous-to-sponsored" | "claim.provider-native-to-sponsor-migration" |
	"claim.single-to-multiple" | "credential.secret-ref-to-plaintext" |
	"persistence.persistent-to-ephemeral" | "profile.postgres-to-generic-relational" |
	"profile.weakened" | "realization.native-to-pack" | "realization.pack-to-bridge" |
	"realtime.websocket-to-polling"

#OfferDegradationNotice: {
	kind:          #WideningKind
	detail:        string & !=""
	placement_id?: string & !=""
}

#OfferSignature: {
	algorithm:      string & !=""
	key_id:         string & !=""
	payload_digest: #Digest
	signature:      string & !=""
}

#DeploymentOffer: {
	schema_version:          "hobo.deployment-offer/v1"
	offer_id:                =~"^offer/[0-9a-f]{64}$"
	recipe_id:               #RecipeId
	deployment_ref:          string & !=""
	topology_digest:         #Digest
	resolution_digest:       #Digest
	catalog_digest:          #Digest
	profile_registry_digest: #Digest
	placements: [...#OfferPlacement] & [_, ...]
	providers: [...#OfferProvider] & [_, ...]
	claim_summary:      #OfferClaimSummary
	source_disclosure:  "public-source" | "private-source" | "not-applicable"
	credential_custody: "secret-ref" | "plaintext"
	required_consents: [...string]
	sponsored_cost_cap_minor_units: int & >=0
	guest_leases: [...#OfferGuestLease]
	trust_evidence_refs: [...string]
	conformance_evidence_refs: [...string]
	portability: #OfferPortability
	degradation_notices: [...#OfferDegradationNotice]
	issued_at_ms:  int & >0
	expires_at_ms: int & >0
	signature:     #OfferSignature
	// An offer that has already expired when it is issued can never be accepted.
	_expiry_after_issue: true & (expires_at_ms > issued_at_ms)
	// Sponsor exposure is only coherent when a sponsored provider is in the
	// deployment, and a sponsored deployment must have consent to disclose.
	_sponsorCapNeedsSponsor: true & (sponsored_cost_cap_minor_units == 0 |
		len([for provider in providers if provider.sponsored {provider}]) > 0)
	// The offer summarizes exactly the providers it places on.
	_providersCoverPlacements: true & (portability.provider_count == len(providers))
}

#DeploymentOfferAcceptance: {
	schema_version:    "hobo.deployment-offer-acceptance/v1"
	offer_id:          string & !=""
	offer_digest:      #Digest
	topology_digest:   #Digest
	resolution_digest: #Digest
	catalog_digest:    #Digest
	accepted_at_ms:    int & >0
	acceptance_digest: #Digest
}
