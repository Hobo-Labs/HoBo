
package architecture_evidence

#NoPrivilegeEscalationPolicyContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#NoPrivilegeEscalationPolicyContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
