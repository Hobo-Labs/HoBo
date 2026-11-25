
package architecture_evidence

#CompensationEscalationContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#CompensationEscalationContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
