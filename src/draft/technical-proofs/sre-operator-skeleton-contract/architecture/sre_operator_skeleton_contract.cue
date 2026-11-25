
package architecture_evidence

#SreOperatorSkeletonContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SreOperatorSkeletonContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
