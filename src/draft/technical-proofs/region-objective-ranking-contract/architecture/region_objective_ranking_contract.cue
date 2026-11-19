
package architecture_evidence

#RegionObjectiveRankingContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#RegionObjectiveRankingContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
