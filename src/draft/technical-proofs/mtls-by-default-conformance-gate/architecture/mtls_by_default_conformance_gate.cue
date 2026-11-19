
package architecture_evidence

#MtlsByDefaultConformanceGateEvidenceKind: "unspecified" | "design-record" | "contract-test"

#MtlsByDefaultConformanceGateRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
