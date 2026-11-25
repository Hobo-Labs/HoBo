
package architecture_evidence

#GenerationBoundedRepairLoopContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#GenerationBoundedRepairLoopContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
