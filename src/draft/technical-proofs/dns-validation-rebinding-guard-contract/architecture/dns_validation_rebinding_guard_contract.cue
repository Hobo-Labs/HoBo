
package architecture_evidence

#DnsValidationRebindingGuardContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DnsValidationRebindingGuardContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
