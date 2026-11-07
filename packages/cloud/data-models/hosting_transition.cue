package cloud

import "list"

#TransitionInteger:       int & >=0 & <=9007199254740991
#HostingTransitionPhase:  int & >=1 & <=12
#HostingTransitionAction: int & >=1 & <=6
#HostingTransitionConstraints: {
	minimumHealthyBackends: *0 | (int & >=0)
	allowedJurisdictions: [string & !="", ...string]
	maximumLatencyMs:         int & >0
	movementClass:            "stateless" | "replicated" | "single-writer"
	observationMaxAgeMs:      int & >0
	rollbackHoldUntilMs:      *0 | #TransitionInteger
	requiredCapabilityDigest: string & !=""
	interruptionAllowed:      bool
	sourceOwnershipEpoch:     #TransitionInteger
}
#HostingDestinationLiability: {
	resourceName:      string & !=""
	providerId:        string & !=""
	providerAccountId: string & !=""
	artifactDigest:    =~"^sha256:[0-9a-f]{64}$"
	mode:              "provider-funded-zero" | "native-finite-term"
	evidenceRef:       string & !=""
	expiresAtMs:       #TransitionInteger
	maximumMicros:     #TransitionInteger
	if mode == "provider-funded-zero" {
		maximumMicros: 0
	}
	if mode == "native-finite-term" {
		expiresAtMs: >0
	}
}
#HostingTransitionPlan: {
	let Owner = tenantId
	let Horizon = horizonEndMs
	schemaVersion: "hobo.hosting-transition/v1"
	transitionId:  string & !=""
	tenantId:      string & !=""
	deploymentId:  string & !=""
	sourcePlanId:  string & !=""
	targetPlanId:  string & !=sourcePlanId
	commitment: {tenantId: Owner, reservedMicros: #TransitionInteger, expectedMicros: #TransitionInteger & <=reservedMicros, ...}
	constraints:             #HostingTransitionConstraints
	intent:                  *"" | "move" | "decommission"
	maximumMutationResumes?: int & >=0 & <=10
	destinationLiabilities?: [...(#HostingDestinationLiability & {expiresAtMs: <=Horizon})]
	sourceLiabilities?: [...(#HostingDestinationLiability & {expiresAtMs: <=Horizon})]
	sourceIncarnationId?: string
	if sourceLiabilities != _|_ {
		if len(sourceLiabilities) > 0 {
			sourceIncarnationId: string & !=""
		}
		let SourceMaximum = list.Sum([for proof in sourceLiabilities {proof.maximumMicros}])
		commitment: reservedMicros: >=SourceMaximum
		if destinationLiabilities != _|_ {
			commitment: reservedMicros: >=(SourceMaximum + list.Sum([for proof in destinationLiabilities {proof.maximumMicros}]))
		}
	}
	if destinationLiabilities != _|_ {
		for proof in destinationLiabilities {
			if proof.expiresAtMs != 0 {
				constraints: {interruptionAllowed: true}
			}
		}
	}
	if intent == "decommission" {
		constraints: {interruptionAllowed: true}
	}
	if intent != "decommission" {
		constraints: {minimumHealthyBackends: int & >=1}
	}
	operationTimeoutMs:         int & >0
	observationBackoffMs:       int & >0
	maximumObservationAttempts: int & >=1 & <=100
	horizonEndMs:               #TransitionInteger
	planDigest:                 string & !=""
	workloadEffectsJson:        string & !=""
	workloadResilienceJson:     string & !=""
	workloadContractDigest:     string & !=""
	workloadContractId:         string & !=""
	adapterContractDigest:      string & !=""
	existingReservationId?:     string
	financialPlanHash?:         "" | =~"^sha256:[0-9a-f]{64}$"
	if existingReservationId != _|_ {
		if existingReservationId != "" {
			financialPlanHash: =~"^sha256:[0-9a-f]{64}$"
			targetPlanId:      financialPlanHash
		}
	}
}
#HostingTransitionOperation: {
	operationId:         string & !=""
	operationDigest:     string & !=""
	action:              #HostingTransitionAction
	startedAtMs:         #TransitionInteger
	deadlineAtMs:        #TransitionInteger & >startedAtMs
	observationAttempts: #TransitionInteger
	nextObservationAtMs: #TransitionInteger
	mutationDispatched:  bool
	mutationResumes?:    int & >=0 & <=10
}
#HostingTransitionObservation: {
	tenantId:                   string & !=""
	transitionId:               string & !=""
	operationId:                string & !=""
	operationDigest:            string & !=""
	observedAtMs:               #TransitionInteger
	outcome:                    "applied" | "absent" | "pending" | "failed"
	healthyBackends:            #TransitionInteger
	latencyMs:                  #TransitionInteger
	sourceQuiescentSequence:    #TransitionInteger
	destinationAppliedSequence: #TransitionInteger
	writeOwnershipEpoch:        #TransitionInteger
	evidenceRef:                string & !=""
	sourcePlanId:               string & !=""
	targetPlanId:               string & !=""
	settledMicros:              #TransitionInteger
	destinationLiabilities?: [...#HostingDestinationLiability]
	destinationLiabilityFinalized?: bool
	...
}
#HostingTransitionState: {
	plan:              #HostingTransitionPlan
	phase:             #HostingTransitionPhase
	operationSequence: #TransitionInteger
	settledMicros:     #TransitionInteger
	version:           #TransitionInteger
	...
}
#HostingTransitionEvent: {eventId: string & !="", kind: string & !="", state: #HostingTransitionState, recordedAtMs: #TransitionInteger}
