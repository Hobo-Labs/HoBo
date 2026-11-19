package roundtrip

#CheckOutcome: "single-declaration" | "parity" | "divergent"

#ManifestCheck: {
	shape:    string & !=""
	owner:    string & !=""
	upstream: string & !=""
	outcome:  #CheckOutcome
	detail:   string & !=""
}

#RoundTripReport: {
	schema: "hobo.manifest-round-trip/v1"
	checks: [...#ManifestCheck] & [_, ...]
}
