
package architecture_evidence

#LifecyclePhasePolicyContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#LifecyclePhasePolicyContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
