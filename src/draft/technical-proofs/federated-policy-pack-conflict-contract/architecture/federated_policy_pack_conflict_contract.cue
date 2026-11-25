
package architecture_evidence

#FederatedPolicyPackConflictContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#FederatedPolicyPackConflictContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
