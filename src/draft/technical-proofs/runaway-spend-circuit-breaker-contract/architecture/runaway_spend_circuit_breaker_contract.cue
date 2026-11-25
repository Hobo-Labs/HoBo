
package architecture_evidence

#RunawaySpendCircuitBreakerContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#RunawaySpendCircuitBreakerContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
