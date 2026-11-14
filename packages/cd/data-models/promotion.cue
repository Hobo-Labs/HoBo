// CUE constraints for the promotion records in cd.proto (WP6: C9, D2, D11,
// D12) and the saga facts the promotion saga appends to `cd-promotion-<id>`.
// Values are protobuf JSON (camelCase fields, enum names, uint64 as decimal
// strings). Self-contained (no package clause):
// `cue vet -c -d '#PromotionRecord' promotion.cue promotion.json`.
//
// Rules that need state (lineage, supersession, idempotency, approvals) live
// in `createPromotionService` (src/promotion/); test/promotion/cue.test.ts
// checks that real bodies vet and that malformed ones do not.

import "strings"

#Text:      string & !="" & strings.MaxRunes(1024)
#Id:        =~"^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$"
#CampId:    =~"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
#Timestamp: =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$"
#UInt64:    =~"^[0-9]+$"
#Principal: =~"^[a-z][a-z0-9-]*:.+$"

#PromotionId: =~"^(promo|rollback|preview)_[0-9a-f]{24}$"

#PromotionState:
	"PROMOTION_STATE_QUEUED" |
	"PROMOTION_STATE_RESOLVING" |
	"PROMOTION_STATE_AWAITING_APPROVAL" |
	"PROMOTION_STATE_AWAITING_WINDOW" |
	"PROMOTION_STATE_APPLYING" |
	"PROMOTION_STATE_ROLLING_OUT" |
	"PROMOTION_STATE_VERIFYING" |
	"PROMOTION_STATE_PROMOTED" |
	"PROMOTION_STATE_ROLLED_BACK" |
	"PROMOTION_STATE_REJECTED" |
	"PROMOTION_STATE_FAILED" |
	"PROMOTION_STATE_SUPERSEDED"

#RolloutStrategy:
	"ROLLOUT_STRATEGY_ALL_AT_ONCE" |
	"ROLLOUT_STRATEGY_CANARY" |
	"ROLLOUT_STRATEGY_BLUE_GREEN" |
	"ROLLOUT_STRATEGY_EXPERIMENT"

#FreightSubject: "FREIGHT_SUBJECT_BINDLE" | "FREIGHT_SUBJECT_RAIL"

#DeltaIntent:
	"promote" | "rollback" | "drift-remediate" | "up" | "down" | "preview" |
	"config" | "topology" | "failover" | "depart" | "posture-remediate"

#ReasonRecord: {
	code:         #Text
	message:      #Text
	remediation:  #Text
	subject?:     string
}

#ObligationRef: {
	id:         #Text
	kind:       #Text
	satisfied?: bool
	deadline?:  #Timestamp
}

#PromotionRecord: {
	schemaVersion: "hobo.cd.promotion/v1"
	promotionId:   #PromotionId
	freightId:     #Id
	sourceCampId?: #CampId
	// Distinct Camps; at least one.
	targetCampIds: [#CampId, ...#CampId]
	pipeline?:       #Id
	node?:           #Id
	state:           #PromotionState
	gateDecisionId?: #Id
	obligations?: [...#ObligationRef]
	requestedBy:     #Principal
	requestedAt:     #Timestamp
	reasons?: [...#ReasonRecord]
	strategy?:       #RolloutStrategy
	proposal?:       bool
	idempotencyKey:  #Text
	fanoutId?:       #Id
	subject:         #FreightSubject
}

#SourceRef: {
	repository?: string
	commit?:     string
	ref?:        string
	ciRunId?:    string
	ciSystem?:   string
	builderId?:  string
}

#PreviewEnvironmentRecord: {
	// Preview Camps are minted as `<source>--pv-<10 hex>`.
	campId:       =~"^[A-Za-z0-9][A-Za-z0-9._-]*--pv-[0-9a-f]{10}$"
	sourceCampId: #CampId
	freightId:    #Id
	ttlMs:        #UInt64 & !="0"
	expiresAt:    #Timestamp
	createdBy:    #Principal
	source?:      #SourceRef
	pipeline?:    #Id
	node?:        #Id
}

// `saga.Started` on a promotion stream: the name carries the Delta intent.
#PromotionSagaStarted: {
	sagaId:      =~"^cd\\.promotion:(promo|rollback|preview)_[0-9a-f]{24}$"
	name:        =~"^cd\\.promotion/(promote|rollback|drift-remediate|up|down|preview|config|topology|failover|depart|posture-remediate)$"
	triggerType: "env.PromoteRequested"
}

#StepName:
	"resolved" | "gated" | "awaiting-window" | "approval-requested" |
	"approved" | "approval-denied" | "before-apply" | "expanded" | "applied" |
	"rollout" | "converged" | "after-converged" | "verification" | "qualified" |
	"after-qualified" | "contracted" | "failed" | "compensated"

// `saga.StepEmitted` on a promotion stream: `<scope>|<step>` plus its handle.
#PromotionSagaStep: {
	sagaId:      =~"^cd\\.promotion:(promo|rollback|preview)_[0-9a-f]{24}$"
	step:        =~"^[A-Za-z0-9][A-Za-z0-9._/-]*\\|(resolved|gated|awaiting-window|approval-requested|approved|approval-denied|before-apply|expanded|applied|rollout|converged|after-converged|verification|qualified|after-qualified|contracted|failed|compensated)$"
	emittedType: string & strings.MaxRunes(1024)
}
