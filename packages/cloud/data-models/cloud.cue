package hobo

// CUE constraints for the Yard control-plane kernel (S2-01) and Planner (S2-02)
// wire records. One constraint per protobuf message in cloud.proto.

#ResourceIntent: {
	name:        string & !=""
	port:        string & !=""
	require: [...string]
	prefer: [...string]
	negotiation: "require" | "prefer"
	deps: [...string]
	region?:     string
	objective:   string & !=""
	placement?:  #PlacementCriteria
}

// ---- E19: placement-constraint vocabulary (HoBo-native; KubeFleet semantics
// cited, shapes native — no Kubernetes types, ADR-0107 non-goal).

#PlacementPropertySelector: {
	key: string & !=""
	op:  "eq" | "ne" | "in" | "not-in" | "lt" | "lte" | "gt" | "gte" | "exists"
	values: [...string]
}

#PlacementAffinityRule: {
	mode:       "affinity" | "anti-affinity"
	targetPort: string & !=""
	scope:      "region" | "yard"
}

#PlacementSpread: {
	dimension: "region" | "yard"
}

#PlacementPickN: {
	count: uint & >0
}

#PlacementCriteria: {
	selectors: [...#PlacementPropertySelector]
	affinities: [...#PlacementAffinityRule]
	spread?: #PlacementSpread
	pickN?:  #PlacementPickN
}

#ResourceDefinitionRef: {
	id:            string & !=""
	providerId:    string & !=""
	port:          string & !=""
	features: [...string]
	regions: [...string]
	specificity:   uint
	priority:      uint
	costSku:       string
	costUnit:      string
	marginalPrice: string
	pricingStatus?: "unknown" | "estimate" | "verified-zero"
	productId?: string & !=""
}

#CapabilityVerdict: {
	kind: "full" | "partial" | "none"
	missing: [...string]
}

#RankedCandidate: {
	definition_id: string & !=""
	provider_id:   string & !=""
	specificity:   uint
	priority:      uint
}

#RejectedCandidate: {
	definition_id: string & !=""
	reason:        string & !=""
}

// Anything that reads as a secret value rather than a locator. Realization
// parameters are provider-native configuration, so a credential-shaped key
// there would put material into a content-addressed plan.
#CloudCredentialKeyPattern: "(?i)(secret|password|token|credential|private[_-]?key|api[_-]?key)"

#MatchDecided: {
	deploymentId: string & !=""
	resource:     string & !=""
	winner:       string & !=""
	providerId:   string & !=""
	port:         string & !=""
	specificity:  uint
	rejected: [...string]
	ranking: [...#RankedCandidate]
	rejectedCandidates: [...#RejectedCandidate]
	tie:          bool
	catalogContentHash: string & !=""
	objective:    string & !=""
	region?:      string
	rationale:    string
	catalogHash:  string & !=""
	// ADR-0157 Yard binding authority. Absent means no Yard constrained the
	// decision, never "any product will do".
	productId?: string & !=""
	appliedRows?: [...string & !=""]
	realizationParameters?: {[!~#CloudCredentialKeyPattern]: string}
	nonPortableRows?: [...string & !=""]
}

#ResourcePlan: {
	name:         string & !=""
	port:         string & !=""
	provider:     string & !=""
	deps: [...string]
	strategy?:     string
	region?:       string
	deploymentId?: string
	// The offering this node resolves to. A deployment driver keys its resolver
	// lookup on it; absent means "not decided here" and the driver fails closed
	// rather than inferring a product from the port (ADR-0144).
	productId?: string & !=""
	// Provider-native realization parameters. Locators only, never values: a
	// credential-shaped key is rejected, matching the parse boundary that builds
	// the Yard binding rows these are merged from.
	realizationParameters?: {[!~#CloudCredentialKeyPattern]: string}
	nonPortableRows?: [...string & !=""]
}

#DeploymentPlan: {
	schema: "hobo.deployment-plan/v1"
	resources: [...#ResourcePlan]
	dependencyOrder: [...string]
	objective: string & !=""
}

#DeploymentPlanned: {
	deploymentId: string & !=""
	planHash:     =~"^sha256:[a-f0-9]{64}$"
	plan:         #DeploymentPlan
}

#PlanRemediation: {
	resource:     string & !=""
	code:         string & !=""
	requiredPort: string & !=""
	requiredFeatures: [...string]
	missing: [...string]
	suggestedProvider?: string
	remediation:  string & !=""
}

#DeploymentPlanRejected: {
	deploymentId: string & !=""
	reason:       string & !=""
	remediations: [...#PlanRemediation] & !=[]
}

#RegistryCatalogEntry: {
	providerId: string & !=""
	definitions: [...#ResourceDefinitionRef]
	manifestIndexDigest: string
}

// provider.Approved fact body: only approved providers are matchable by the
// Planner; registration alone leaves a provider held.
#ProviderApprovedRecord: {
	providerId: string & !=""
	approvedBy?: string & !=""
}

// ---- S2-03a/b: Orchestrator + ResourceActor FSM + Executor constraints ----
// One constraint per new protobuf message in cloud.proto.

#ResourceActorState: "Pending" | "Planning" | "Provisioning" | "Provisioned" |
	"Updating" | "Failed" | "Compensating" | "Destroying" | "Destroyed"

#IacProgram: {
	programId:    string & !=""
	deploymentId: string & !=""
	resourceId:   string & !=""
	provider:     string & !=""
	driver:       string & !=""
	action:       "preview" | "apply" | "destroy"
	stackName:    string & !=""
}

#ScopedCredential: {
	id:         string & !=""
	scope:      string & !=""
	ttlSeconds: uint & >0
	ambient:    false
}

#ExecOutputRecord: {
	execId: string & !=""
	stream: "stdout" | "stderr"
	line:   string
}

#ExecDiffRecord: {
	execId:  string & !=""
	summary: string
	changes: uint
}

#ExecSucceededRecord: {
	execId:      string & !=""
	outputsHash: string & !=""
	outputs: {[string]: string}
}

#ExecFailedRecord: {
	execId:         string & !=""
	classification: "retryable" | "fatal"
	reason:         string & !=""
}

#ResourceActorSnapshot: {
	deploymentId: string & !=""
	resourceId:   string & !=""
	state:        #ResourceActorState
	sequence:     uint
	outputs: {[string]: string}
	deps: [...string]
}

#ResourceProvisioningRecord: {
	deploymentId: string & !=""
	resourceId:   string & !=""
	execId:       string & !=""
	programHash:  string & !=""
}

#ResourceProvisionedRecord: {
	deploymentId: string & !=""
	resourceId:   string & !=""
	outputs: {[string]: string}
	execId:       string & !=""
}

#ResourceFailedRecord: {
	deploymentId:          string & !=""
	resourceId:            string & !=""
	reason:                string & !=""
	classification:        "retryable" | "fatal"
	crossedNoGoThreshold:  bool
}

#ResourceDestroyingRecord: {
	deploymentId: string & !=""
	resourceId:   string & !=""
	reason:       string & !=""
}

#ResourceDestroyedRecord: {
	deploymentId:   string & !=""
	resourceId:     string & !=""
	finalStateHash: string & !=""
}

#DeploymentDeployedRecord: {
	deploymentId: string & !=""
	setId:        string & !=""
	resourceIds: [...string]
}

#DeploymentRolledBackRecord: {
	deploymentId: string & !=""
	targetSetId:  string & !=""
	reason:       string & !=""
}

// ---- S3-04: CredentialAudit projection constraints (one per protobuf message) ----

#CredentialAuditScope: {
	port:     string & !=""
	resource: string & !=""
	action:   string & !=""
}

#CredentialGrantAudit: {
	grantId:        string & !=""
	svidSubject?:   string
	scope?:         #CredentialAuditScope
	tokenRef?:      string
	status:         "granted" | "used" | "revoked"
	grantedAt?:     string
	usedAt?:        string
	revokedAt?:     string
	revokedReason?: string
	useCount:       uint
}

#CredentialAuditTimelineEntry: {
	seq:      uint
	type:     string & !=""
	grantId?: string
}

#CredentialAuditRecord: {
	correlationId: string & !=""
	grants: {[string]: #CredentialGrantAudit}
	identityIds: [...string]
	sessionIds: [...string]
	timeline: [...#CredentialAuditTimelineEntry]
	grantCount:  uint
	useCount:    uint
	revokeCount: uint
}

// Continuous Delivery plane records
#ResolvedDeploymentSetRecord: {
	schema_version:          string
	set_id:                  string
	tenant:                  string
	environment:             string
	camp_id:                 string
	plan_hash:               string
	content_hash:            string
	gatekeeper_decision_id:  string
	gatekeeper_decision:     "allow" | "allow-degraded"
}

#AttestedPrincipalRecord: {
	svid_subject:            string
	identity_id:             string
	tenant:                  string
	code_digest:             string
	component_image_digest:  string
	attestation_state:       "attested"
	isolation_tier:          string
}

#SecretFreeStatusRecord: {
	schema_version: string
	resource_id:    string
	state:          string
	secret_free:    true
}

#SafetyEnvelopeRecord: {
	schema_version:       string
	blast_radius:         "none" | "resource" | "camp" | "tenant" | "unknown"
	reversible:           bool
	spend_cap_usd:        uint
	estimated_spend_usd:  uint
	self_causation:       bool
	max_attempts:         uint
	attempts_used:        uint
	requires_lane:        true
}

#A2HHandoffRecord: {
	schema_version: string
	incident_id:    string
	signal:         string
	tenant:         string
	environment:    string
	deployment_id:  string
	set_id:         string
	deadline:       string
	obligation_id:  string
}

// ---- E21: TopologyView app-graph read model constraints ----

#TopologyNode: {
	id:    string & !=""
	kind:  "bindle" | "resource" | "yard"
	label: string & !=""
	port?:       string
	providerId?: string
	region?:     string
	lifecycle?: "provisioning" | "provisioned" | "failed" | "destroying" | "destroyed"
}

#TopologyEdge: {
	from: string & !=""
	to:   string & !=""
	kind: "binding" | "placement"
	region?: string
}

#TopologyViewRow: {
	deploymentId: string & !=""
	bindleHash?:  string
	nodes: [...#TopologyNode]
	edges: [...#TopologyEdge]
}

#LaneGrantRecord: {
	lane_id:                       string
	tenant:                        string
	membership:                    "granted"
	fork_on_touch:                 true
	baseline_single_writer_lease:  false
	baseline_mutation:             false
	external_side_effects:         "mock" | "explicit-grant"
}
