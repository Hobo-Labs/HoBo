
package architecture_evidence

#TierFourOverlayMeshContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#TierFourOverlayMeshContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
