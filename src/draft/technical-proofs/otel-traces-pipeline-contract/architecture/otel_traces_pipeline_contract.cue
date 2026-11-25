
package architecture_evidence

#OtelTracesPipelineContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#OtelTracesPipelineContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
