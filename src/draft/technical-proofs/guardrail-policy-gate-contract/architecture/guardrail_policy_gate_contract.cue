
package architecture_evidence

#GuardrailPolicyGateContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#GuardrailPolicyGateContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
