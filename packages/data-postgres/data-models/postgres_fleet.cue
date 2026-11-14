package data_models

import "list"

// Invariants for the Postgres-specific fleet records. Each mirrors a check the
// TypeScript code makes, so a record it would not write is refused here too.

#PostgresFleetBackendId: string & =~"^[a-z0-9][a-z0-9_-]{0,62}$"

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

#PostgresFleetReplicationStatus: "replicated" | "refused" | "failed"

#PostgresFleetReplicationResult: {
	source:     #PostgresFleetBackendId
	target:     #PostgresFleetBackendId & !=source
	epoch:      int & >=1
	status:     #PostgresFleetReplicationStatus
	refusal?:   "same-backend" | "source-is-not-writer" | "target-is-writer" | "target-log-differs" | "schema-mismatch" | "oversized" | "busy" | "digest-mismatch"
	failureHealth?: "HEALTH_DRAINING" | "HEALTH_PRESSURED" | "HEALTH_UNREACHABLE" | "HEALTH_QUOTA_EXHAUSTED" | "HEALTH_AUTH" | "HEALTH_UNKNOWN"
	rows?:      int & >=0
	bytes?:     int & >=0
	durationMs: int & >=0

	// Each status carries its own detail and no other.
	if status == "refused" {
		refusal: string
	}
	if status == "failed" {
		failureHealth: string
	}
	if status == "replicated" {
		rows:     int
		bytes:    int
		refusal?:       _|_
		failureHealth?: _|_
	}
}

#PostgresFleetTransitionStep: "bootstrap" | "seal" | "activate" | "unseal" | "failover" | "membership"

#PostgresFleetTransition: {
	step:    #PostgresFleetTransitionStep
	status:  "decided" | "undecided" | "stale" | "unavailable" | "refused"
	epoch?:  int & >=1
	active?: #PostgresFleetBackendId
	target?: #PostgresFleetBackendId
	reason:  string & =~"^[a-z0-9][a-z0-9:._ -]{0,199}$"

	// Only sealing, for a switch or a failover, names a target.
	if step != "seal" && step != "failover" {
		target?: _|_
	}
}
