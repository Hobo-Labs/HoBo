package data_models

import (
	"list"
	"strings"
)

// Invariants for the fleet records. Each mirrors a check the TypeScript
// parsers make, so a record `parseFleetAssignment` refuses is refused here too.

#PostgresFleetBackendId: string & =~"^[a-z0-9][a-z0-9_-]{0,62}$"

#PostgresFleetAssignment: {
	epoch:         int & >=1
	active?:       #PostgresFleetBackendId
	sealed:        bool
	target?:       #PostgresFleetBackendId
	reason:        string & =~"^[a-z0-9][a-z0-9:._ -]{0,199}$"
	lossWindowMs?: int & >=0
	decidedAtMs:   int & >=0
	decidedBy:     string & =~"^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$"

	// A sealed fleet is moving somewhere, and not to where it already is.
	if sealed {
		target: #PostgresFleetBackendId
		if active != _|_ {
			target: !=active
		}
	}
	// An unsealed entry has no target: there is no move in flight.
	if !sealed {
		target?: _|_
	}
}

#PostgresFleetDigest: string & =~"^[0-9a-f]{64}$"

#PostgresFleetReplicatedTable: {
	name:   string & =~"^[a-z_][a-z0-9_]{0,62}$"
	rows:   int & >=0
	digest: #PostgresFleetDigest
}

#PostgresFleetWatermark: {
	source:       #PostgresFleetBackendId
	sourceEpoch:  int & >=1
	snapshotAtMs: int & >=0
	tables: [...#PostgresFleetReplicatedTable]
	rowCount:  int & >=0
	byteCount: int & >=0
	digest:    #PostgresFleetDigest

	// The total is the sum of its parts; a watermark cannot claim more rows
	// than its tables hold.
	rowCount: list.Sum([for t in tables {t.rows}])
}

#PostgresFleetUsageUnit: "operations" | "compute-hours" | "storage-bytes"

#PostgresFleetUsage: {
	period: string & =~"^[0-9]{4}-(0[1-9]|1[0-2])$"
	unit:   #PostgresFleetUsageUnit
	used:   int & >=0
}

#PostgresFleetUsageMeasurement: {
	unit: #PostgresFleetUsageUnit
	used: int & >=0
}

#PostgresFleetBackendHealth: "reachable" | "unreachable" | "quota-exhausted" | "auth" | "unknown"

#PostgresFleetObservation: {
	backend:         #PostgresFleetBackendId
	health:          #PostgresFleetBackendHealth
	probeLatencyMs?: int & >=0
	failingForMs:    int & >=0
	schemaCurrent:   bool
	standbyLagMs?:   int & >=0
	usage: [...#PostgresFleetUsageMeasurement]

	// A reachable backend is not failing.
	if health == "reachable" {
		failingForMs: 0
	}
}

#PostgresFleetOverageKind: "hard-stop" | "metered" | "unknown"

#PostgresFleetAllowance: {
	unit:                  #PostgresFleetUsageUnit
	included?:             int & >=0
	beyond:                #PostgresFleetOverageKind
	meteredMicrosPerUnit?: int & >=0

	// Exactly a metered allowance carries a price.
	if beyond == "metered" {
		meteredMicrosPerUnit: int & >=0
	}
	if beyond != "metered" {
		meteredMicrosPerUnit?: _|_
	}
}

#PostgresFleetEvidence: {
	source:     string & !="" & strings.MaxRunes(300)
	observedAt: string & =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
}

#PostgresFleetFinancialModel: {
	backend:                #PostgresFleetBackendId
	plan:                   string & =~"^[a-z0-9][a-z0-9 ._-]{0,63}$"
	fixedMonthlyFeeMicros?: int & >=0
	allowances: [...#PostgresFleetAllowance]
	evidence: #PostgresFleetEvidence

	// Each unit has at most one allowance.
	_units: [for a in allowances {a.unit}]
	_unique: list.UniqueItems(_units) & true
}

#PostgresFleetFeasibility: "feasible" | "unknown" | "infeasible"

#PostgresFleetCandidate: {
	backend:       #PostgresFleetBackendId
	eligible:      bool
	feasibility:   #PostgresFleetFeasibility
	lagMs?:        int & >=0
	exhaustsInMs?: int & >=0
	reasons: [...string]
}

#PostgresFleetAction: "keep" | "hold" | "switch" | "failover"

#PostgresFleetDecision: {
	action:        #PostgresFleetAction
	epoch:         int & >=1
	writer?:       #PostgresFleetBackendId
	target?:       #PostgresFleetBackendId
	lossWindowMs?: int & >=0
	reasons: [...string]
	candidates: [...#PostgresFleetCandidate]
	decidedAtMs: int & >=0

	// Only a move has a target, and only an unplanned one loses anything.
	if action == "switch" || action == "failover" {
		target: #PostgresFleetBackendId
	}
	if action == "keep" || action == "hold" {
		target?: _|_
	}
	if action != "failover" {
		lossWindowMs?: _|_
	}
}
