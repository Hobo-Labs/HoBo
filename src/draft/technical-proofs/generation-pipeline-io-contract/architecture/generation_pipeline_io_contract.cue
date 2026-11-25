
package architecture_evidence

#GenerationPipelineIoContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#GenerationPipelineIoContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
