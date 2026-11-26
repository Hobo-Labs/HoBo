package vibe_snapshop_launch_demo_storyboard

#SnapshopStoryStep: "scaffold" | "local-run" | "inspect" | "plan" | "live-recording-slot" | "failure-recovery" | "support-docs-handoff"
#SnapshopAssetKind: "screenshots" | "recording-manifest" | "command-transcript" | "fixture-data" | "docs"
#SnapshopScenario: "happy-path" | "blocked-path" | "stale-or-unknown-evidence" | "support-handoff"
#SnapshopProofMode: "live" | "simulated" | "reference fixture" | "scope-out"
#QuickstartFixtureId: "rlq-define-object-graph-v1" |
	"rlq-collect-manifest-ir-v1" |
	"rlq-plan-safe-preview-v1" |
	"rlq-deploy-run-accepted-v1" |
	"rlq-inspect-event-projection-v1" |
	"rlq-manage-stale-evidence-v1" |
	"rlq-recover-snapshot-restore-v1" |
	"rlq-recover-scope-out-v1"
#QuickstartProofMode: "reference-fixture" | "simulated" | "live" | "scope-out"

#VibeSnapshopLaunchDemoStoryboard: {
	issue: "HOBO-555"
	phase: "M5"
	packagePath: "src/draft/exp-proofs/ux/vibe-snapshop-launch-demo-storyboard"
	proofPath: "docs/design/proofs/vibe-snapshop-launch-demo-storyboard/README.md"
	designRefs: [...string]
	proofModes: [...#SnapshopProofMode]
	quickstartFixtureRefs: [...#SnapshopQuickstartFixtureReference]
	storyboardSteps: [...#SnapshopStoryboardStep]
	assetMap: [...#SnapshopAssetMapEntry]
	scenarioPaths: [...#SnapshopScenarioPath]
	accessibilityNotes: [...=~"^.+$"] & [_, ...]
	scopeOut: [...string]
}

#SnapshopQuickstartFixtureReference: {
	sourceIssue: "HOBO-577"
	fixtureId: #QuickstartFixtureId
	proofMode: #QuickstartProofMode
	consumingStep: #SnapshopStoryStep
	storyboardUse: string & != ""
}

#SnapshopStoryboardStep: {
	id: #SnapshopStoryStep
	title: string & != ""
	commandOrSurface: string & != ""
	proofMode: #SnapshopProofMode
	fixtureId: #QuickstartFixtureId
	evidenceObject: string & != ""
	owner: string & != ""
	safeClaim: string & != ""
	supportDocsHandoff: string & != ""
}

#SnapshopAssetMapEntry: {
	kind: #SnapshopAssetKind
	source: string & != ""
	owner: string & != ""
	proofMode: #SnapshopProofMode
	refreshTrigger: string & != ""
	validationRoute: string & != ""
	staleDowngrade: string & != ""
}

#SnapshopScenarioPath: {
	id: #SnapshopScenario
	narrative: string & != ""
	stepIds: [...#SnapshopStoryStep] & [_, ...]
	assetKinds: [...#SnapshopAssetKind] & [_, ...]
	proofModeLabels: [...#SnapshopProofMode] & [_, ...]
	accessibilityNote: string & != ""
	supportHandoff: string & != ""
	safeOutcome: string & != ""
}
