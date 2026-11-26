// CUE constraints for every protobuf type in this package's schema.

package architecture_evidence

#GovernancePlanesS6EvidenceKind: "unspecified" | "consent-notify" | "residency-erasure" | "guardrail-block" | "certified-install"

#GovernancePlanesS6Record: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...#GovernancePlanesS6EvidenceKind]
}
