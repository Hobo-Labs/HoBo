package architecture_evidence

#GenerationScaffoldStageContractEvidenceKind: "unspecified" | "contract-record" | "contract-test"

#GenerationScaffoldStageContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

