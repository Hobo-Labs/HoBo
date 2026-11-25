
package architecture_evidence

#FlagDebtAutoCleanupContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#FlagDebtAutoCleanupContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
