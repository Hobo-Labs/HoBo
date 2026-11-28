
package architecture_evidence

#LaunchPerformanceCapacityEnvelopeContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#LaunchPerformanceCapacityEnvelopeContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
