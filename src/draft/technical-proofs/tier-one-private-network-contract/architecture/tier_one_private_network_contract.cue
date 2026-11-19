
package architecture_evidence

#TierOnePrivateNetworkContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#TierOnePrivateNetworkContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
