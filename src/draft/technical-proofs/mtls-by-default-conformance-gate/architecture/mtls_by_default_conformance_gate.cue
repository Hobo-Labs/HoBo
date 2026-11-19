// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#MtlsByDefaultConformanceGateEvidenceKind: "unspecified" | "design-record" | "contract-test"

#MtlsByDefaultConformanceGateRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

