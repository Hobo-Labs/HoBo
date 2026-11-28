
package architecture_evidence

#RuntimePortConformanceContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#RuntimePortConformanceContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
