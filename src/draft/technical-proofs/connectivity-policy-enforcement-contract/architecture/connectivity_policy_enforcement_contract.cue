
package architecture_evidence

#ConnectivityPolicyEnforcementContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ConnectivityPolicyEnforcementContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
