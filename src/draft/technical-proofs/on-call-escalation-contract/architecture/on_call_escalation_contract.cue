
package architecture_evidence

#OnCallEscalationContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#OnCallEscalationContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
