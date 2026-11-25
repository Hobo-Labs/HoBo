
package architecture_evidence

#DnsValidationGateThreatModelEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DnsValidationGateThreatModelRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
