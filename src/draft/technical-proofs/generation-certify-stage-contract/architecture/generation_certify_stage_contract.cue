
package architecture_evidence

#GenerationCertifyStageContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#GenerationCertifyStageContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
