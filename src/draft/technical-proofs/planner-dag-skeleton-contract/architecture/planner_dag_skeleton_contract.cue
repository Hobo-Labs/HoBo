// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#PlannerDagSkeletonContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#PlannerDagSkeletonContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

