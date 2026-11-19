
package architecture_evidence

#ReactorSkeletonContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ReactorSkeletonContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
