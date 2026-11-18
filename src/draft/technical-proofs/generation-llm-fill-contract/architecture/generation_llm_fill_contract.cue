package architecture_evidence

#GenerationLlmFillContractEvidenceKind: "unspecified" | "contract-record" | "contract-test"

#GenerationLlmFillContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

