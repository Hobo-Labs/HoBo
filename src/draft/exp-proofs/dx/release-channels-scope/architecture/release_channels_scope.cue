// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#ReleaseChannelsScopeEvidenceKind: "unspecified" | "design-record" | "contract-test" | "reference-fixture" | "audit-fixture" | "support-handoff"

#ReleaseChannelsScopeRecord: {
	issue:             "HOBO-431"
	project:           "Release Channels"
	phase:             "M0"
	goal:              string & !=""
	boundaries:        [...#ReleaseChannelsBoundary]
	required_evidence: [...#ReleaseChannelsEvidence]
}

#ReleaseChannelsBoundary: {
	id:      "service" | "ux" | "security" | "support"
	owner:   string & !=""
	promise: string & !=""
}

#ReleaseChannelsEvidence: {
	id:    string & !=""
	owner: string & !=""
	proof: string & !=""
}
