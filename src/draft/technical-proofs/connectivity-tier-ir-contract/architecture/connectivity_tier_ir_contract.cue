
package architecture_evidence

#ConnectivityTierIrContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ConnectivityTierIrContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
