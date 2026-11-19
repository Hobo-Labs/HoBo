
package architecture_evidence

#IdJagTokenExchangeContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#IdJagTokenExchangeContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
