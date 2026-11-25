
package architecture_evidence

#TrustTierPolicyContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#TrustTierPolicyContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
