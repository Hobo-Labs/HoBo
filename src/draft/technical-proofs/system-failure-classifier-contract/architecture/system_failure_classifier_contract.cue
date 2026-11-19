
package architecture_evidence

#SystemFailureClassifierContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SystemFailureClassifierContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
