
package architecture_evidence

#AccessibilityUsabilityLaunchBaselineContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#AccessibilityUsabilityLaunchBaselineContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
