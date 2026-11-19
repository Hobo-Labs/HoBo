
package architecture_evidence

#PlanDiffViewerScopeAcceptanceEvidenceKind: "unspecified" | "design-record" | "contract-test"

#PlanDiffViewerScopeAcceptanceRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
