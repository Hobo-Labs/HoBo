
package architecture_evidence

#DefaultRoleActionMatrixContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DefaultRoleActionMatrixContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
