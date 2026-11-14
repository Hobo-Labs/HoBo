// CUE constraints for the fan-out records in cd.proto (WP23: D21, I20) and
// the event bodies on `cd-fanout-<id>`. Values are protobuf JSON (camelCase
// fields, enum names, uint64 as decimal strings, defaults omitted).
// Self-contained (no package clause):
// `cue vet -c -d '#FanoutRecord' fanout.cue fanout.json`.
//
// Rules that need the decision (mandatory groups exist, a Camp sits in one
// group, limits resolved against the decision size) live in
// `parseFanoutPlan` (src/fanout/policy.ts); test/fanout/cue.test.ts checks
// the two agree on everything CUE can express.

import "strings"

#Timestamp: =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"
#UInt64:    =~"^[0-9]+$"
#Percent:   int & >=0 & <=100
#Id:        string & !="" & strings.MaxRunes(256)
#Slug:      =~"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"
#FanoutId:  =~"^fanout-[0-9a-f]{32}$"

#ReasonRecord: {
	code:        string & !=""
	message?:    string & strings.MaxRunes(1024)
	remediation: string & !="" & strings.MaxRunes(1024)
	subject?:    string & strings.MaxRunes(1024)
}

#FanoutStrategy: "FANOUT_STRATEGY_UNSPECIFIED" | "FANOUT_STRATEGY_ALL" | "FANOUT_STRATEGY_PROGRESSIVE" | "FANOUT_STRATEGY_PROGRESSIVE_PER_GROUP"

#DepartureAction: "DEPARTURE_ACTION_UNSPECIFIED" | "DEPARTURE_ACTION_DELETE" | "DEPARTURE_ACTION_ORPHAN" | "DEPARTURE_ACTION_ORPHAN_DATA"

#FanoutState: "FANOUT_STATE_UNSPECIFIED" | "FANOUT_STATE_RUNNING" | "FANOUT_STATE_HALTED" | "FANOUT_STATE_COMPLETED" | "FANOUT_STATE_ROLLED_BACK" | "FANOUT_STATE_SUPERSEDED"

// A limit is a count or a percent of the decision, never both.
#FanoutRecord: {
	strategy?:              #FanoutStrategy
	maxConcurrency?:        int & >=0
	maxConcurrencyPercent?: #Percent
	minSuccessMs?:          #UInt64
	progressDeadlineMs?:    #UInt64
	maxFailures?:           int & >=0
	maxFailuresPercent?:    #Percent
	mandatoryGroups?: [...#Slug]
	rollbackOnHalt?: bool
	if maxConcurrency != _|_ if maxConcurrency > 0 {
		maxConcurrencyPercent?: 0
	}
	if maxFailures != _|_ if maxFailures > 0 {
		maxFailuresPercent?: 0
	}
}

#QuorumRecord: {
	minQualified?:        int & >=0
	minQualifiedPercent?: #Percent
	if minQualified != _|_ if minQualified > 0 {
		minQualifiedPercent?: 0
	}
}

#FanoutStatusRecord: {
	fanoutId:    #FanoutId
	pipeline:    #Id
	node:        #Id
	freightId:   #Id
	decisionId:  #Id
	state:       #FanoutState & !="FANOUT_STATE_UNSPECIFIED"
	groupIndex?: int & >=0
	pending?: [...#Id]
	inFlight?: [...#Id]
	succeeded?: [...#Id]
	failed?: [...#Id]
	deferred?: [...#Id]
	reasons?: [...#ReasonRecord]
	updatedAt: #Timestamp
}

// ── Event bodies on cd-fanout-<id> ─────────────────────────────────────────

#FanoutStartedBody: {
	fanoutId:  #FanoutId
	pipeline:  #Id
	node:      #Id
	freightId: #Id
	decision: {
		decisionId: #Id
		pipeline:   #Id
		node:       #Id
		...
	}
	fanout:         #FanoutRecord
	departure:      #DepartureAction
	windows:        [...#Id]
	idempotencyKey: #Id
	departing:      [...#Id]
	atMs:           int & >=0
	// The decision is for this node.
	decision: pipeline: pipeline
	decision: node:     node
}

#SlotOutcome: "requested" | "bound" | "succeeded" | "failed" | "deferred" | "rolled-back" | "supersede-requested"

#FanoutProgressedBody: {
	// Empty only for the node-level supersede request.
	campId:      string & strings.MaxRunes(256)
	outcome:     #SlotOutcome
	promotionId: string
	catchUp:     bool
	reasons:     [...#ReasonRecord]
	atMs:        int & >=0
	status?:     #FanoutStatusRecord
	if outcome != "supersede-requested" {
		campId: #Id
	}
	if outcome == "bound" || outcome == "rolled-back" {
		promotionId: #Id
	}
}

#FanoutHaltedBody: {
	reason:  #ReasonRecord
	atMs:    int & >=0
	status?: #FanoutStatusRecord & {state: "FANOUT_STATE_HALTED"}
}

#FanoutResumedBody: {
	baseline: int & >=0
	atMs:     int & >=0
	status?:  #FanoutStatusRecord & {state: "FANOUT_STATE_RUNNING"}
}

// fanout.Completed (COMPLETED or SUPERSEDED) and fanout.RolledBack.
#FanoutStatusBody: {
	atMs:    int & >=0
	campIds: [...#Id]
	reasons: [...#ReasonRecord]
	status?: #FanoutStatusRecord & {state: "FANOUT_STATE_COMPLETED" | "FANOUT_STATE_SUPERSEDED" | "FANOUT_STATE_ROLLED_BACK"}
}

#CampDepartedBody: {
	fanoutId:    #FanoutId
	campId:      #Id
	action:      #DepartureAction & !="DEPARTURE_ACTION_UNSPECIFIED"
	promotionId: string
	// Resources left in place: none for DELETE.
	kept:    [...#Id]
	reasons: [...#ReasonRecord]
	atMs:    int & >=0
	if action == "DEPARTURE_ACTION_DELETE" {
		kept: []
	}
}
