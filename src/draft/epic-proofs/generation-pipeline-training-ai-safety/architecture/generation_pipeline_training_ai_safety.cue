package architecture_evidence

#GenerationPipelineTrainingAiSafetyEvidenceKind: "unspecified" | "contract-record" | "contract-test"

#GenerationPipelineTrainingAiSafetyRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

