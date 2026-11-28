
package architecture_evidence

#PortabilityReportContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#PortabilityReportContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
