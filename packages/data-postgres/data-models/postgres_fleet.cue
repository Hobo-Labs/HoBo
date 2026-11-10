package data_models

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
