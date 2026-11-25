
package architecture_evidence

#GenerationScaffoldStageContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#GenerationScaffoldStageContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
