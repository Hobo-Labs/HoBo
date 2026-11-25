
package architecture_evidence

#TutorialsWalkthroughsScopeAcceptanceEvidenceKind: "unspecified" | "design-record" | "contract-test" | "reference-fixture" | "agent-fixture" | "support-handoff" | "accessibility-note"

#TutorialsWalkthroughsScopeAcceptanceRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
