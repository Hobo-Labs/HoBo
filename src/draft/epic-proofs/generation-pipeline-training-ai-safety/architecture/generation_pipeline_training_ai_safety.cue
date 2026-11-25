
package architecture_evidence

#GenerationPipelineTrainingAiSafetyEvidenceKind: "unspecified" | "design-record" | "contract-test"

#GenerationPipelineTrainingAiSafetyRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
