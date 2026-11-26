package hobo

// CUE constraints for proof wire records.
// Parse, don't validate: production packages own derived types; proof consumes them.

#ProofRun: {
	scenario: "native-kafka" | "dapr-kafka" | "actor-dual" | "junction-federation"
	ok:       bool
	fidelity: "simulated" | "live"
	notes:    string
}

#AcceptanceRow: {
	id:       int & >=1
	scenario: string & !=""
	ok:       bool
}
