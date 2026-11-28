
package architecture_evidence

#MetricsCatalogPipelineContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#MetricsCatalogPipelineContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
