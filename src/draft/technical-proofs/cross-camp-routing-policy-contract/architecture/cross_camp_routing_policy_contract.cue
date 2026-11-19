
package architecture_evidence

#CrossCampRoutingPolicyContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#CrossCampRoutingPolicyContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
