
package architecture_evidence

#StructuredLogPipelineContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#StructuredLogPipelineContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
