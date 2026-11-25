
package architecture_evidence

#TierTwoCrossRegionNetworkContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#TierTwoCrossRegionNetworkContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
