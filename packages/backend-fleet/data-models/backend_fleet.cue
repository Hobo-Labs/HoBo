package data_models

import ( "list"

)

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

	if sealed {
		target: #FleetBackendId
		if active != _|_ {
			target: !=active
		}
	}

	if !sealed {
		target?: _|_
	}
}

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

#ContinuityFleetPlan: {
	tier:                   string & !=""
	rpo_ms:                 int & >=0
	failover_after_ms:      int & >=1000
	min_dwell_ms:           int & >=0
	standbys:               int & >=0
	copy:                   "snapshot" | "cold"
	copy_every_ms:          int & >=0
	backup_every_ms:        int & >=0
	backups_kept:           int & >=0
	monthly_budget_micros?: int & >=0
	if copy == "cold" {
		copy_every_ms: 0
	}
	if copy == "snapshot" {
		copy_every_ms: >=15000
	}
}
