
package architecture_evidence

#HoboMonorepoSkeletonContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboMonorepoSkeletonContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
