
package architecture_evidence

#ContractEnginePortContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ContractEnginePortContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
