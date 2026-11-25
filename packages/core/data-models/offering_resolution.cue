// CUE constraints for every protobuf type in offering_resolution.proto, so
// the architecture guard can confirm the generic offering-resolution shapes
// are bounded at parse time.

package core

#ResourceOfferingRecord: {
	id:        string & !=""
	stability: "stable" | "preview" | "experimental"
	fidelity:  "real" | "simulated" | "mocked" | "camp-only"
	features: [...string & !=""]
}

#ResourceOfferingProfileRecord: {
	provider: string & !=""
	offerings: [...#ResourceOfferingRecord]
	fallbacks: [...string & !=""]
}

#ResourceOfferingRequestRecord: {
	features: [...string & !=""]
	negotiation: "prefer" | "require"
}

#ResourceOfferingMatchRecord: {
	kind: "full" | "partial" | "none"
	offerings: [...string & !=""]
	missing: [...string & !=""]
	fallbacks: [...string & !=""]
	remediation?: string
}

#ResourceOfferingResolveResultRecord: {
	kind:      "resolved" | "unresolved"
	provider?: string
	strategy: [...string & !=""]
	match?: #ResourceOfferingMatchRecord
	missing: [...string & !=""]
	remediation?: string
}

#StationOfferingRegistrationRecord: {
	station_id:     string & !=""
	resource_class: string & !=""
	profile:        #ResourceOfferingProfileRecord
	registered_at:  string & !=""
}
