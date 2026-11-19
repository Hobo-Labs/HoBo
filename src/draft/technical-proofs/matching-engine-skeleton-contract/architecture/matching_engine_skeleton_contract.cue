
package architecture_evidence

#MatchingEngineSkeletonContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#MatchingEngineSkeletonContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
