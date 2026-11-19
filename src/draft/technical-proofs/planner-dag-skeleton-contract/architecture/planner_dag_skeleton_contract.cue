
package architecture_evidence

#PlannerDagSkeletonContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#PlannerDagSkeletonContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
