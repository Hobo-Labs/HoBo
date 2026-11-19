
package architecture_evidence

#FeatureFlagGovernanceContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#FeatureFlagGovernanceContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
