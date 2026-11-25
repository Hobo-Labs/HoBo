package vibe_representative_a11y_usability_checks

#RepresentativeArtifact: "onboarding" |
	"plan-diff" |
	"deployment-dashboard" |
	"marketplace" |
	"docs" |
	"support" |
	"publisher" |
	"launch-demo"

#RepresentativeCheckId: "keyboard-path" |
	"screen-reader-smoke" |
	"responsive-layout" |
	"contrast-threshold" |
	"reduced-motion" |
	"state-clarity" |
	"copy-clarity"

#SourceIssue: "HOBO-554" | "HOBO-577"

#ProofMode: "live" | "simulated" | "reference fixture" | "scope-out"

#QuickstartFixtureId: "rlq-define-object-graph-v1" |
	"rlq-plan-safe-preview-v1" |
	"rlq-inspect-event-projection-v1" |
	"rlq-deploy-run-accepted-v1" |
	"rlq-manage-stale-evidence-v1" |
	"rlq-recover-snapshot-restore-v1" |
	"rlq-collect-manifest-ir-v1" |
	"rlq-recover-scope-out-v1"

#QuickstartProofMode: "reference-fixture" | "simulated" | "live" | "scope-out"

#VibeRepresentativeA11yUsabilityChecks: {
	issue:       "HOBO-565"
	phase:       "M2"
	packagePath: "src/draft/exp-proofs/ux/vibe-representative-a11y-usability-checks"
	proofPath:   "docs/design/proofs/vibe-representative-a11y-usability-checks/README.md"
	designRefs: [...string]
	sourceIssues: [#SourceIssue, ...#SourceIssue]
	quickstartFixtureRefs: [...#RepresentativeQuickstartFixtureReference]
	checkDefinitions:      [...#RepresentativeCheckDefinition]
	artifactChecks:        [...#RepresentativeArtifactChecks]
	scenarios:             [...#RepresentativeScenario]
	proofModeLabels:       [...#ProofMode]
	scopeOut: [...string]
}

#RepresentativeCheckDefinition: {
	id:           #RepresentativeCheckId
	label:        string & != ""
	evidenceKind: string & != ""
	proves:       string & != ""
}

#RepresentativeCheckEvidence: {
	checkId:                #RepresentativeCheckId
	expectedEvidence:       string & != ""
	severity:               "launch-blocker" | "major" | "minor"
	ownerRoute:             string & != ""
	acceptedRiskPath:       string & != ""
	launchReadinessImpact:  string & != ""
}

#RepresentativeArtifactChecks: {
	artifact:              #RepresentativeArtifact
	title:                 string & != ""
	ownerRoute:            string & != ""
	acceptedRiskPath:      string & != ""
	checklistSourceIssue:  "HOBO-554"
	quickstartFixtureId:   #QuickstartFixtureId
	checks:                [...#RepresentativeCheckEvidence]
	proofModeLabels:       [...#ProofMode]
	accessibilityNote:     string & != ""
}

#RepresentativeQuickstartFixtureReference: {
	sourceIssue:       "HOBO-577"
	fixtureId:         #QuickstartFixtureId
	proofMode:         #QuickstartProofMode
	consumingArtifact: #RepresentativeArtifact
	representativeUse: string & != ""
}

#RepresentativeScenario: {
	id:               "happy-path" | "blocked-path" | "stale-or-unknown-evidence" | "support-handoff" | "accessibility-notes" | "proof-mode-labels"
	artifactRefs:     [...#RepresentativeArtifact]
	requiredEvidence: [...string]
	safeOutcome:      string & != ""
}
