
package architecture_evidence

#SecopsPolicyAuditJourneyContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SecopsPolicyAuditJourneyContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
