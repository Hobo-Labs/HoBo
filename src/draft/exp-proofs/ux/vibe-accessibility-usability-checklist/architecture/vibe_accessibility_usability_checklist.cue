package vibe_accessibility_usability_checklist

#AccessibilityCheckId: "keyboard-only-path" |
	"focus-order" |
	"visible-focus" |
	"semantic-labels" |
	"contrast" |
	"responsive-layout" |
	"reduced-motion" |
	"screen-reader-smoke" |
	"empty-error-loading-states" |
	"copy-clarity"

#LaunchSurface: "workspace-onboarding" |
	"plan-diff" |
	"deployment-dashboard" |
	"marketplace-install" |
	"publisher-portal" |
	"docs" |
	"admin-support" |
	"release-support-artifacts"

#ProofMode: "live" | "simulated" | "reference fixture" | "scope-out"

#QuickstartFixtureId: "rlq-define-object-graph-v1" |
	"rlq-collect-manifest-ir-v1" |
	"rlq-plan-safe-preview-v1" |
	"rlq-deploy-run-accepted-v1" |
	"rlq-inspect-event-projection-v1" |
	"rlq-manage-stale-evidence-v1" |
	"rlq-recover-snapshot-restore-v1" |
	"rlq-recover-scope-out-v1"

#QuickstartProofMode: "reference-fixture" | "simulated" | "live" | "scope-out"

#AcceptedRiskRoute: "launch-cutline-review" |
	"release-owner-review" |
	"product-owner-remediation" |
	"support-owner-route"

#VibeAccessibilityChecklist: {
	issue:       "HOBO-554"
	phase:       "M1"
	packagePath: "src/draft/exp-proofs/ux/vibe-accessibility-usability-checklist"
	proofPath:   "docs/design/proofs/vibe-accessibility-usability-checklist/README.md"
	designRefs: [...string]
	quickstartFixtureRefs: [#AccessibilityQuickstartFixtureReference, ...#AccessibilityQuickstartFixtureReference]
	checks:           [...#AccessibilityCheck]
	surfaceChecklist: [...#SurfaceChecklistEntry]
	scenarios:        [...#ChecklistScenario]
	scopeOut: [...string]
}

#AccessibilityCheck: {
	id:           #AccessibilityCheckId
	label:        string & != ""
	evidenceMode: string & != ""
	proves:       string & != ""
}

#SurfaceChecklistEntry: {
	surface:           #LaunchSurface
	owner:             string & != ""
	evidenceMode:      string & != ""
	requiredChecks:    [...#AccessibilityCheckId]
	launchSeverity:    "launch-blocker" | "major" | "minor"
	acceptedRiskRoute: #AcceptedRiskRoute
	proofModes:        [...#ProofMode]
}

#AccessibilityQuickstartFixtureReference: {
	sourceIssue:       "HOBO-577"
	fixtureId:         #QuickstartFixtureId
	proofMode:         #QuickstartProofMode
	consumingSurface:  #LaunchSurface
	accessibilityUse:  string & != ""
}

#ChecklistScenario: {
	id:               "happy-path" | "blocked-path" | "stale-or-unknown-evidence" | "support-handoff" | "accessibility-notes" | "proof-mode-labels"
	surfaceRefs:      [...#LaunchSurface]
	requiredEvidence: [...string]
	safeOutcome:      string & != ""
}
