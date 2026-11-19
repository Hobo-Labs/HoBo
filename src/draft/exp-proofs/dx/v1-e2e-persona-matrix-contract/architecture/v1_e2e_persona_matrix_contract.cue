
package architecture_evidence

#V1E2ePersonaMatrixContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#V1E2ePersonaMatrixContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
