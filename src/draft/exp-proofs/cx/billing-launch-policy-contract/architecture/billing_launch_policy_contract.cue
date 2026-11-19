
package architecture_evidence

#BillingLaunchPolicyContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#BillingLaunchPolicyContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
