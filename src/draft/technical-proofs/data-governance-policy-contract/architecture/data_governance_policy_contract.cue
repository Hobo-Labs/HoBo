
package architecture_evidence

#DataGovernancePolicyContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DataGovernancePolicyContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
