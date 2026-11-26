// CUE constraints for the rollout records in cd.proto and the rollout ledger
// bodies (WP10, D7, D8, D12). Values are protobuf JSON: camelCase fields, enum
// names, uint64 as decimal strings; proto3 JSON omits defaults, so scalar
// fields are optional unless a record is meaningless without them.
// `package rollout` keeps these definitions apart from the other cd.proto
// constraint files in this folder.
//
// The TypeScript parse boundaries are src/rollout/lowering.ts
// (stagePercentsFor, lowerCamp) and src/rollout/journal.ts (foldRollout);
// test/rollout/cue.test.ts proves the two agree.
package rollout

import (
	"list"
)

#Timestamp: =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"
#Id:        =~"^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$"
#RolloutId: =~"^rollout-[0-9a-f]{32}$"

#ReasonRecord: {
	code:        string & !=""
	message?:    string
	remediation: string & !=""
	subject?:    string
}

#RolloutStrategy: "ROLLOUT_STRATEGY_ALL_AT_ONCE" | "ROLLOUT_STRATEGY_CANARY" | "ROLLOUT_STRATEGY_BLUE_GREEN" | "ROLLOUT_STRATEGY_EXPERIMENT"

// D7 rungs, best first; anything else is never chosen by lowering.
#TrafficRung: "edge.canary" | "lb.weighted" | "dns.weighted" | "inprocess.weighted"

// One Camp's lowering: either a rung (with the rungs skipped above it) or a
// refusal — never both, and a progressive strategy never has neither.
#RolloutLoweringRecord: {
	campId:        #Id
	strategy:      #RolloutStrategy
	offeringId?:   #TrafficRung
	fallbackFrom?: [...#TrafficRung]
	refusal?:      #ReasonRecord

	_hasRung:    offeringId != _|_
	_hasRefusal: refusal != _|_
	if strategy != "ROLLOUT_STRATEGY_ALL_AT_ONCE" {
		_exactlyOne: true & ((_hasRung && !_hasRefusal) || (!_hasRung && _hasRefusal))
		if refusal != _|_ {
			_refusalCode: "progressive-unsupported" & refusal.code
		}
	}
	if strategy == "ROLLOUT_STRATEGY_ALL_AT_ONCE" {
		_neither: true & (!_hasRung && !_hasRefusal)
	}
}

#StagePercent: int & >0 & <=100

#RolloutPlanRecord: {
	rolloutId:     #RolloutId
	promotionId:   #Id
	strategy:      #RolloutStrategy
	stagePercents: list.MinItems(1) & [...#StagePercent]
	targetCampIds: list.MinItems(1) & list.UniqueItems() & [...#Id]
	lowerings:     [...#RolloutLoweringRecord]
	verification?: {...}
	experimentId?: #Id

	// Strictly ascending, ending fully shifted at 100.
	_ascending: true & list.IsSorted(stagePercents, list.Ascending) & list.UniqueItems(stagePercents)
	_endsAt100: true & (stagePercents[len(stagePercents)-1] == 100)
	// One lowering per target Camp.
	_lowered: true & (len(lowerings) == len(targetCampIds))
	if strategy == "ROLLOUT_STRATEGY_ALL_AT_ONCE" || strategy == "ROLLOUT_STRATEGY_BLUE_GREEN" {
		stagePercents: [100]
	}
	if strategy == "ROLLOUT_STRATEGY_EXPERIMENT" {
		experimentId: #Id
	}
}

// ── Ledger bodies on cd-rollout-<rolloutId> ──────────────────────────────────

#ObligationRef: {
	id?:        string
	kind?:      string
	satisfied?: bool
	deadline?:  string
}

// rollout.Lowered
#RolloutLowered: {
	plan:      #RolloutPlanRecord
	freightId: #Id
	windows: [...string]
	obligations: [...#ObligationRef]
	refused: bool
	at:      #Timestamp
	// A refused plan names at least one lowering refusal; an accepted one none.
	_refusals: [for l in plan.lowerings if l.refusal != _|_ {l}]
	if refused {
		_hasRefusal: true & (len(_refusals) > 0)
	}
	if !refused {
		_noRefusal: true & (len(_refusals) == 0)
	}
}

#ShiftPhase: "stage" | "rollback"

#RolloutShiftRequested: {
	campId:     #Id
	stageIndex: int & >=-1
	phase:      #ShiftPhase
	percent:    int & >=0 & <=100
	planId:     string & !=""
	at:         #Timestamp
	// Zero exposure is the only rollback shift.
	if phase == "rollback" {
		percent:    0
		stageIndex: -1
	}
	if phase == "stage" {
		percent:    #StagePercent
		stageIndex: int & >=0
	}
}

#RolloutShifted: {
	campId:     #Id
	stageIndex: int & >=-1
	phase:      #ShiftPhase
	planId:     string & !=""
	realized:   "full" | "partial" | "none" | "unknown"
	notes: [...string]
	at: #Timestamp
}

#RolloutVerificationPhase: "idle" | "stage"

#RolloutStageVerified: {
	campId:         #Id
	stageIndex:     int & >=0
	phase:          #RolloutVerificationPhase
	verificationId: string & !=""
	verdict:        "VERIFICATION_VERDICT_PASS" | "VERIFICATION_VERDICT_FAIL" | "VERIFICATION_VERDICT_INCONCLUSIVE"
	at:             #Timestamp
}

#RolloutHeld: {
	reason: #ReasonRecord & {code: "window-closed" | "rollout-rollback-window-closed" | "rollout-experiment-running" | "rollout-approval-pending"}
	at: #Timestamp
}

#RolloutRollbackDeltaOpened: {
	campId:  #Id
	deltaId: string
	why:     "rollback" | "no-predecessor" | "not-applied"
	at:      #Timestamp
	if why == "rollback" {
		deltaId: =~"^delta-rollback-[0-9a-f]{24}$"
	}
	if why != "rollback" {
		deltaId: ""
	}
}

#RolloutFinished: {
	status: "promoted" | "rolled-back" | "failed"
	reasons: [...#ReasonRecord]
	at: #Timestamp
	// Anything but a promotion says why.
	if status != "promoted" {
		reasons: list.MinItems(1)
	}
}
