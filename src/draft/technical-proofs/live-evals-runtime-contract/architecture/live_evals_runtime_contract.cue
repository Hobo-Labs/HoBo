
package architecture_evidence

#LiveEvalsRuntimeContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#LiveEvalsRuntimeContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
