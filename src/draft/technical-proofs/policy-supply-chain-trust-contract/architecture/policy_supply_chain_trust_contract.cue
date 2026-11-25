
package architecture_evidence

#PolicySupplyChainTrustContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#PolicySupplyChainTrustContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
