
package architecture_evidence

#ClientOptimisticUpdateContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ClientOptimisticUpdateContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
