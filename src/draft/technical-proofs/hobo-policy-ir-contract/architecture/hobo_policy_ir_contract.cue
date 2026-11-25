
package architecture_evidence

#HoboPolicyIrContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboPolicyIrContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
