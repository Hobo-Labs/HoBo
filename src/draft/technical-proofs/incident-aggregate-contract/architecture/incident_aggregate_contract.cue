
package architecture_evidence

#IncidentAggregateContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#IncidentAggregateContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
