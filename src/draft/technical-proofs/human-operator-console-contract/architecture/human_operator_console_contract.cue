
package architecture_evidence

#HumanOperatorConsoleContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HumanOperatorConsoleContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
