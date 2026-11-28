
package architecture_evidence

#RuntimeLocalExecutionLimitsContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#RuntimeLocalExecutionLimitsContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
