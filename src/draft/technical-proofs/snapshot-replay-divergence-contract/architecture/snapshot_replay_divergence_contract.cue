
package architecture_evidence

#SnapshotReplayDivergenceContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SnapshotReplayDivergenceContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
