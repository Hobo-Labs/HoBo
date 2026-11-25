
package architecture_evidence

#GenerationLlmFillContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#GenerationLlmFillContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
