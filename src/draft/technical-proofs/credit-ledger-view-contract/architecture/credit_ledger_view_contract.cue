
package architecture_evidence

#CreditLedgerViewContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#CreditLedgerViewContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
