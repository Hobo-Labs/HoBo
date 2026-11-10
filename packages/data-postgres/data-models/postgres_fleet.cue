package data_models

import "list"

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
