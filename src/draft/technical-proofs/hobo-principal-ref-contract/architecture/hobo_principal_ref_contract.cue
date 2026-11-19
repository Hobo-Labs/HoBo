
package architecture_evidence

#HoboPrincipalRefContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboPrincipalRefContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
