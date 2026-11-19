
package architecture_evidence

#EndUserAuthorizationPolicyContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#EndUserAuthorizationPolicyContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
