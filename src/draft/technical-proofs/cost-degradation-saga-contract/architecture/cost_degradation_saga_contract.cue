
package architecture_evidence

#CostDegradationSagaContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#CostDegradationSagaContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
