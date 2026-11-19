
package architecture_evidence

#GenerationValidationStageContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#GenerationValidationStageContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
