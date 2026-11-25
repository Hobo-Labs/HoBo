
package architecture_evidence

#E2eTestMatrixScopeAcceptanceEvidenceKind: "unspecified" | "design-record" | "contract-test"

#E2eTestMatrixScopeAcceptanceRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
