
package architecture_evidence

#CqrsCommandAggregateContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#CqrsCommandAggregateContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
