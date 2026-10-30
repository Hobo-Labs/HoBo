package architecture_evidence

// This schema uses protobuf JSON names, exactly as the parser receives them.
#Money: number & >=0 & <=9007199254.740991
#Nonempty: string & !=""
#Version: =~"^v[0-9]+\\.[0-9]+\\.[0-9]+$"

#ResourceIntent: {
	schemaVersion: "hobo.finops.resource-intent/v1"
	owner: #OwnerRef
	capability: #CapabilityClass
	budget: #Budget
	constraints: #Constraints
	routing: {objective: "balanced" | "cost" | "reliability" | "performance" | "customBlend"}
}
#OwnerRef: {tenant: #Nonempty, workspace: #Nonempty, environment: #Nonempty}
#CapabilityClass: {
	category: #Nonempty
	requirements: {
		availability: string
		latencyP95Ms: number & >=0
		minAvailability: number & >=0 & <=1
		durability: string
		compliance: #Nonempty
		if availability == "high" {minAvailability: >=0.95}
	}
}
#Budget: {
	amount: #Money
	currency: "USD"
	period: "monthly" | "yearly"
	softLimitBehavior: "notify" | "requireApproval"
	hardLimitBehavior: "deny" | "freeze" | "suspend"
}
#Constraints: {
	allowedJurisdictions: [#Nonempty, ...#Nonempty]
	disallowedJurisdictions: [...#Nonempty]
	maxCost: #Money
	minSecurityLevel: number & >=0
}
#BudgetState: {
	spendToDate: #Money
	committedCost: #Money
	uncertainCost: #Money
	recoveryReserve: #Money
}
#RoutingCandidate: {
	id: #Nonempty
	capabilityClass: #Nonempty
	monthlyCost: #Money
	transitionCost: #Money
	commitmentBound: #Money & >=(monthlyCost + transitionCost)
	period: "monthly" | "yearly"
	reliability: number & >=0 & <=1
	latencyP95Ms: number & >=0
	risk: number & >=0 & <=1
	compliance: [...#Nonempty]
	jurisdiction: #Nonempty
	securityLevel: number & >=0
	eligible: bool
	abstractTraits: [...string]
}
#MetricContract: {
	name: #Nonempty
	tier: "system" | "derived" | "user"
	version: #Version
	unit?: string
	source?: string
	normalization?: string
	mutable?: false
	dependsOn?: [...#Nonempty]
	transforms?: [...("weighted_sum" | "ratio")]
	compositionSources?: [...#Nonempty]
	weights?: {[string]: number & >=0 & <=1}
	requiresApproval?: bool
	approvalState?: string
	approvalRef?: string
	if tier == "system" {unit: #Nonempty, source: #Nonempty, normalization: #Nonempty}
	if tier == "derived" {dependsOn: [#Nonempty, ...#Nonempty], transforms: ["weighted_sum" | "ratio"]}
	if tier == "user" {requiresApproval: true, approvalState: "approved", approvalRef: #Nonempty, compositionSources: [#Nonempty, ...#Nonempty]}
}
#RoutingSnapshot: {
	catalogHash: #Nonempty
	metricRegistryHash: #Nonempty
	budgetId: #Nonempty
	periodId: #Nonempty
	policyRevision: #Nonempty
	ledgerSeq: int & >=0
	observedAt: #Nonempty
}
#RoutingDecisionHistory: {
	candidateId: #Nonempty
	decidedAt: #Nonempty
	flipsInWindow?: int & >=0
	challengerCandidateId?: string
	challengerSince?: string
}
#PreferenceModel: {
	costWeight: number & >=0 & <=1
	reliabilityWeight: number & >=0 & <=1
	latencyWeight: number & >=0 & <=1
	riskWeight: number & >=0 & <=1
	customWeights?: {[string]: number & >=0 & <=1}
	normalizationVersion: "fixed-reference/v1"
}
#StabilityPolicy: {
	minImprovementThreshold: number & >=0 & <=1
	cooldownMs: int & >=0
	migrationPenalty: number & >=0 & <=1
	flipLimitPerWindow: int & >=1
	flipWindowMs: int & >=1
	dwellMs: int & >=0
}
#RoutingScenario: {
	id: #Nonempty
	intent: #ResourceIntent
	candidates: [...#RoutingCandidate]
	metricContracts: [#MetricContract, ...#MetricContract]
	history: [...#RoutingDecisionHistory]
	budgetState: #BudgetState
	snapshot: #RoutingSnapshot
	preference?: #PreferenceModel
	stability?: #StabilityPolicy
}
#FinopsBudgetRoutingControlPlane: #RoutingScenario

// Named records retain the public contract family. The scenario parser is the
// executable input boundary; output views additionally carry derived evidence.
#CapabilityRequirements: {
	availability: string
	latencyP95Ms: number & >=0
	minAvailability: number & >=0 & <=1
	durability: string
	compliance: #Nonempty
}
#RoutingPreferences: {objective: "balanced" | "cost" | "reliability" | "performance" | "customBlend"}
#BudgetScope: #OwnerRef
#ConstraintResult: {candidateId: #Nonempty, passed: bool, reasons: [...string]}
#MetricVector: {
	candidateId: #Nonempty
	cost: #Money
	reliability: number & >=0 & <=1
	latency: number & >=0
	risk: number & >=0 & <=1
	customMetrics: {[string]: number & >=0 & <=1}
	normalizedMetrics: {[string]: number & >=0 & <=1}
}
#ParetoFrontier: {candidateIds: [...string], dominatedCandidateIds: [...string]}
#DecisionGraph: {
	id: #Nonempty
	generatedCandidateIds: [...string]
	constraintResults: [...#ConstraintResult]
	metricVectors: [...#MetricVector]
	paretoFrontier: #ParetoFrontier
	finalCandidateId?: string
	rationale: [...string]
	snapshot: #RoutingSnapshot
	inputHash: #Nonempty
}
#RoutingDecision: {id: #Nonempty, effect: "allow" | "deny" | "requireApproval", selectedCandidateId?: string, decisionGraphId: #Nonempty}
#ActionPlan: {id: #Nonempty, decisionId: #Nonempty, abstractActions: [...("deploy" | "destroy" | "scale" | "migrate" | "pause" | "freeze" | "upgrade")], backendNeutral: true}
#FeedbackProposal: {id: #Nonempty, source: #Nonempty, target: #Nonempty, effect: "propose-metric-change" | "propose-policy-review" | "propose-weight-review"}
#MetricVersionChange: {metricName: #Nonempty, fromVersion: #Version, toVersion: #Version, approvalState: "requires-approval" | "approved" | "rejected"}
#MeterDefinition: {name: #Nonempty, unit: #Nonempty, source: #Nonempty}
#MeterMapping: {meterName: #Nonempty, capabilityClass: #Nonempty, costClass: #Nonempty}
#FocusCostLedgerEntry: {focusVersion: #Nonempty, chargePeriod: #Nonempty, billingCurrency: "USD", effectiveCost: #Money}
#Forecast: {period: #Nonempty, projectedCost: #Money, currency: "USD"}
#BudgetRoutingPolicy: {id: #Nonempty, expressionLanguage: "CEL" | "Rego", allowedInputs: [...string]}
#PolicyBinding: {policyId: #Nonempty, scope: #BudgetScope}
#DerivedMetric: {name: #Nonempty, dependsOn: [#Nonempty, ...#Nonempty], transforms: ["weighted_sum" | "ratio"]}
#UserMetric: {name: #Nonempty, compositionSources: [#Nonempty, ...#Nonempty], requiresApproval: true}
#ActionResult: {actionPlanId: #Nonempty, status: "accepted" | "blocked" | "completed" | "failed"}
#AllocationRule: {id: #Nonempty, strategy: "usage-share" | "equal" | "weighted"}
#ApprovalRequest: {id: #Nonempty, decisionId: #Nonempty, approverRole: #Nonempty}
#ExceptionGrant: {id: #Nonempty, scope: #Nonempty, expiresAt: #Nonempty}
#SimulationRequest: {id: #Nonempty, scenarios: [...string]}
#SimulationResult: {requestId: #Nonempty, decisionGraphIds: [...string], surfaceViews: [...("dx" | "opsx" | "finx")]}
