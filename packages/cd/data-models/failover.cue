// CUE constraints for the failover and rebalance records in cd.proto (WP23:
// D23, I21) and the event bodies on `cd-failover-<id>`. Values are protobuf
// JSON (camelCase fields, enum names, uint64 as decimal strings, defaults
// omitted). Self-contained (no package clause):
// `cue vet -c -d '#FailoverRecord' failover.cue failover.json`.
//
// Rules that need the journal or other records (Rail permission, the
// Station's concurrency budget, residency of the replacement, data resources
// in the source) live in src/failover/; test/failover/cue.test.ts checks the
// recorded bodies vet clean.

import "strings"

#Timestamp:  =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"
#UInt64:     =~"^[0-9]+$"
#Id:         string & !="" & strings.MaxRunes(256)
#FailoverId: =~"^failover-[0-9a-f]{32}$"
#Principal:  =~"^(user|agent|service|system):.+$"

#ReasonRecord: {
	code:        string & !=""
	message?:    string & strings.MaxRunes(1024)
	remediation: string & !="" & strings.MaxRunes(1024)
	subject?:    string & strings.MaxRunes(1024)
}

#PurgeMode: "PURGE_MODE_UNSPECIFIED" | "PURGE_MODE_GRACEFUL" | "PURGE_MODE_NEVER" | "PURGE_MODE_IMMEDIATE"

#FailoverState: "FAILOVER_STATE_UNSPECIFIED" | "FAILOVER_STATE_PROPOSED" | "FAILOVER_STATE_REPLACING" | "FAILOVER_STATE_VERIFYING" | "FAILOVER_STATE_SHIFTING" | "FAILOVER_STATE_PURGING" | "FAILOVER_STATE_COMPLETED" | "FAILOVER_STATE_REFUSED" | "FAILOVER_STATE_ABANDONED"

// Handover outputs are declared names only, never values (I9).
#FailoverPolicyRecord: {
	purge?:   #PurgeMode
	graceMs?: #UInt64
	handoverOutputs?: [...=~"^[A-Za-z_][A-Za-z0-9_.-]{0,127}$"]
}

#RailFailoverRecord: {
	automatic?:           bool
	maxConcurrent?:       int & >=0
	allowImmediatePurge?: bool
	requiredSignals?:     int & >=0
}

#FailoverRecord: {
	failoverId:     #FailoverId
	pipeline:       #Id
	node:           #Id
	fromCampId:     #Id
	toCampId?:      #Id
	freightId?:     #Id
	state:          #FailoverState & !="FAILOVER_STATE_UNSPECIFIED"
	purge:          #PurgeMode & !="PURGE_MODE_UNSPECIFIED"
	triggerTaint?:  string
	decisionId?:    string
	promotionId?:   string
	handover?: {[string]: string & strings.MaxRunes(4096)}
	reasons?: [...#ReasonRecord]
	updatedAt: #Timestamp
	// A failover past PROPOSED has a replacement and a promotion.
	if state == "FAILOVER_STATE_REPLACING" || state == "FAILOVER_STATE_VERIFYING" || state == "FAILOVER_STATE_SHIFTING" || state == "FAILOVER_STATE_PURGING" || state == "FAILOVER_STATE_COMPLETED" {
		toCampId:    #Id
		freightId:   #Id
		promotionId: #Id
	}
	// Never the same Camp (no self-failover).
	if toCampId != _|_ {
		toCampId: !=fromCampId
	}
}

#RebalanceMoveRecord: {
	fromCampId: #Id
	toCampId:   #Id & !=fromCampId
}

#RebalanceRecord: {
	rebalanceId: =~"^[0-9a-f]{32}$"
	pipeline:    #Id
	node:        #Id
	decisionId:  #Id
	moves?: [...#RebalanceMoveRecord]
	reason?:     string & strings.MaxRunes(1024)
	requestedBy: #Principal
	requestedAt: #Timestamp
}

// ── Event bodies ───────────────────────────────────────────────────────────

// failover.Proposed / Started / Progressed / Completed / Refused.
#FailoverBody: {
	failover:      #FailoverRecord
	stationId:     string
	rebalanceId:   string
	approved:      bool
	approvedBy:    string
	decisionId:    string
	routingPlanId: string
	purged:        bool
	limit:         int & >=0
	startedAtMs:   int & >=0
	atMs:          int & >=0
	if approved {
		approvedBy: #Principal
	}
	// Rebalance moves always purge GRACEFUL (D23).
	if rebalanceId != "" {
		failover: purge: "PURGE_MODE_GRACEFUL"
	}
}

// rebalance.Requested on cd-failover-rebalance-<id>.
#RebalanceRequestedBody: {
	rebalance: #RebalanceRecord
	limit:     int & >=1
}
