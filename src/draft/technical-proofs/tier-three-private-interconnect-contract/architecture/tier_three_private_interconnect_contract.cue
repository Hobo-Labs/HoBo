
package architecture_evidence

#TierThreePrivateInterconnectContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#TierThreePrivateInterconnectContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
