// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#TutorialsWalkthroughsScopeAcceptanceEvidenceKind: "unspecified" | "design-record" | "contract-test" | "reference-fixture" | "agent-fixture" | "support-handoff" | "accessibility-note"

#TutorialsWalkthroughsScopeAcceptanceRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
