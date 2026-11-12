package data_models

import "list"

// Invariants for every record in backend_fleet.proto. Each mirrors a check the
// TypeScript parsers in src/ make (parseFleetAssignment, parseFleetFinancialModel,
// parseFleetOffer, parseFleetRoutingMarks), so a record they refuse is
// refused here too. Field names are the protobuf JSON names.

#FleetBackendId: string & =~"^[a-z0-9][a-z0-9_-]{0,62}$"

#FleetAssignment: {
	epoch:         int & >=1
	active?:       #FleetBackendId
	sealed:        bool
	target?:       #FleetBackendId
	reason:        string & =~"^[a-z0-9][a-z0-9:._ -]{0,199}$"
	lossWindowMs?: int & >=0
	decidedAtMs:   int & >=0
	decidedBy:     string & =~"^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$"

	// A sealed fleet is moving somewhere, and not to where it already is.
	if sealed {
		target: #FleetBackendId
		if active != _|_ {
			target: !=active
		}
	}
	// An unsealed entry has no target: there is no move in flight.
	if !sealed {
		target?: _|_
	}
}

// A replica's log: format 1, at most the newest 32 entries, ascending by
// epoch with no gap (rule 2 of the register).
#FleetAssignmentLog: {
	format: 1
	entries: [...#FleetAssignment] & list.MaxItems(32)
}

#FleetUsageUnit: "operations" | "compute-hours" | "storage-bytes" | "commands" | "rows-read" | "rows-written" | "simple-operations" | "advanced-operations"

#FleetUsageMeasurement: {
	unit: #FleetUsageUnit
	used: int & >=0
}

#FleetBackendHealth: "reachable" | "unreachable" | "quota-exhausted" | "auth" | "unknown"

#FleetObservation: {
	backend:         #FleetBackendId
	health:          #FleetBackendHealth
	probeLatencyMs?: int & >=0
	failingForMs:    int & >=0
	schemaCurrent:   bool
	standbyLagMs?:   int & >=0
	usage: [...#FleetUsageMeasurement]
	// A reachable backend is not failing.
	if health == "reachable" {
		failingForMs: 0
	}
}

#FleetOverageKind: "hard-stop" | "metered" | "unknown"

#FleetAllowance: {
	unit:                  #FleetUsageUnit
	included?:             int & >=0
	beyond:                #FleetOverageKind
	meteredMicrosPerUnit?: number & >=0
	// Exactly a metered allowance carries a price.
	if beyond == "metered" {
		meteredMicrosPerUnit: number & >=0
	}
	if beyond != "metered" {
		meteredMicrosPerUnit?: _|_
	}
}

#FleetEvidence: {
	source:     string & =~"^.{1,300}$"
	observedAt: string & =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
}

#FleetFinancialModel: {
	backend:                #FleetBackendId
	plan:                   string & =~"^[a-z0-9][a-z0-9 ._-]{0,63}$"
	fixedMonthlyFeeMicros?: int & >=0
	allowances: [...#FleetAllowance]
	evidence: #FleetEvidence
}

#FleetFeasibility: "feasible" | "unknown" | "infeasible"

#FleetCandidate: {
	backend:       #FleetBackendId
	eligible:      bool
	feasibility:   #FleetFeasibility
	lagMs?:        int & >=0
	exhaustsInMs?: int & >=0
	reasons: [...string]
}

#FleetAction: "keep" | "hold" | "switch" | "failover"

#FleetDecision: {
	action:        #FleetAction
	epoch:         int & >=1
	writer?:       #FleetBackendId
	target?:       #FleetBackendId
	lossWindowMs?: int & >=0
	reasons: [...string]
	candidates: [...#FleetCandidate]
	decidedAtMs: int & >=0
	// A move names where it goes; keep and hold do not.
	if action == "switch" || action == "failover" {
		target: #FleetBackendId
	}
}

#FleetOfferTier: "free" | "prepaid" | "payg"

#FleetOffer: {
	model:      #FleetFinancialModel
	tier:       #FleetOfferTier
	capMicros?: int & >=0
}

#FleetRoutingMarks: {
	switchAt:        number & >0 & <=1
	switchBackBelow: number & >0 & <switchAt
	minDwellMs:      int & >=0
	failoverAfterMs: int & >=0
}

#FleetRouteCandidate: {
	backend:              #FleetBackendId
	tier?:                #FleetOfferTier
	eligible:             bool
	projectedFraction?:   number & >=0
	projectedCostMicros?: int & >=0
	reasons: [...string]
}

#FleetRoute: {
	action:  #FleetAction
	epoch:   int & >=1
	active?: #FleetBackendId
	target?: #FleetBackendId
	reasons: [...string]
	candidates: [...#FleetRouteCandidate]
	decidedAtMs: int & >=0
	if action == "switch" || action == "failover" {
		target: #FleetBackendId
	}
}
