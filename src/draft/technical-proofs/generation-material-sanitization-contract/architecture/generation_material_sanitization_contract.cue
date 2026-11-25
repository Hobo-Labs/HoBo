
package architecture_evidence

#GenerationMaterialSanitizationContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#GenerationMaterialSanitizationContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
