
package architecture_evidence

#ExecutorSkeletonContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ExecutorSkeletonContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
