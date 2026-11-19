
package architecture_evidence

#AgentGuardrailsContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#AgentGuardrailsContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
