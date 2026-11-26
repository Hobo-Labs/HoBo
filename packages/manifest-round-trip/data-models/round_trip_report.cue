// CUE constraints for the cross-manifest decomposition report.
//
// One constraint per protobuf message in round_trip_report.proto. These carry
// what proto3 cannot state: the closed outcome vocabulary as strings rather
// than an enum with an UNSPECIFIED zero value, non-emptiness on every string,
// and a non-empty check list.
package roundtrip

// The three verdicts a check can reach. Spelled as a closed string union
// rather than mirroring the proto enum names, because the TypeScript domain
// type and the JSON a report is read from both use these spellings, and a
// second vocabulary would be a second thing to keep in sync.
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
	// A report with no checks proves nothing, so an empty list is not a valid
	// report — it is a report that failed to run.
	checks: [...#ManifestCheck] & [_, ...]
}
