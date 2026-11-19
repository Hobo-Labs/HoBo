
package architecture_evidence

#PolicyAuditExportContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#PolicyAuditExportContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
