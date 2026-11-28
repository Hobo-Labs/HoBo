
package architecture_evidence

#CapabilityReviewApprovalScopeEvidenceKind: "unspecified" | "design-record" | "contract-test"

#CapabilityReviewApprovalScopeRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
