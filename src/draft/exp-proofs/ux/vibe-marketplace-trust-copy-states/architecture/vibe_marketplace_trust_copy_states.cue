package vibe_marketplace_trust_copy_states

import "list"

#ScenarioKind: "preview-warning" | "installable-with-evidence" | "policy-block" | "deprecated-guidance" | "yanked-support-route" | "hidden-listing"
#ListingState: "not-visible" | "preview-only" | "limited-beta" | "installable" | "blocked-by-policy" | "deprecated" | "yanked"
#Path: "happy" | "blocked" | "stale-or-unknown" | "support-handoff"
#ProofMode: "reference-fixture" | "simulated" | "live" | "scope-out"
#QuickstartProofMode: "reference-fixture" | "simulated" | "live" | "scope-out"
#AccessibilityCheck: "keyboard-only" | "focus-order" | "semantic-labels" | "contrast" | "responsive-layout" | "reduced-motion" | "screen-reader-smoke" | "state-copy-clarity"
#FixtureId: =~"^mtc-[a-z0-9-]+-v[0-9]+$"
#QuickstartFixtureId: "rlq-collect-manifest-ir-v1" | "rlq-plan-safe-preview-v1" | "rlq-deploy-run-accepted-v1" | "rlq-manage-stale-evidence-v1" | "rlq-recover-scope-out-v1"

#Copy: {
	headline:   string & =~"\\S"
	body:       string & =~"\\S"
	nextAction: string & =~"\\S"
}

#AccessibilityNote: {
	check: #AccessibilityCheck
	note:  string & =~"\\S"
}

#Scenario: {
	kind:               #ScenarioKind
	fixtureId:          #FixtureId
	listingState:       #ListingState
	path:               #Path
	proofMode:          #ProofMode
	audience:           string & =~"\\S"
	ownerRoute:         string & =~"\\S"
	evidenceSource:     string & =~"\\S"
	safeClaim:          string & =~"\\S"
	copy:               #Copy
	accessibilityNotes: [...#AccessibilityNote] & list.MinItems(8)
}

#Handoff: {
	owner:      string & =~"\\S"
	consumes:   string & =~"\\S"
	mustNotOwn: [...string] & list.MinItems(1)
}

#QuickstartRef: {
	sourceIssue:  "HOBO-577"
	fixtureId:    #QuickstartFixtureId
	proofMode:    #QuickstartProofMode
	copyStates:   [...#ScenarioKind] & list.MinItems(1)
	trustCopyUse: string & =~"\\S"
}

#MarketplaceTrustCopyStates: {
	issue:         "HOBO-547"
	phase:         "M1"
	targetPackage: "src/draft/exp-proofs/ux/vibe-marketplace-trust-copy-states"
	proofNote:     "docs/design/proofs/vibe-marketplace-trust-copy-states/README.md"
	designRefs:    [...string] & list.MinItems(1)
	quickstartFixtureRefs: [...#QuickstartRef] & list.MinItems(5)
	scopeOut: [
		"production UI",
		"publisher portal UI",
		"approval service",
		"security scanner",
		"policy engine",
		"notification delivery",
		"support queue",
		"launch claims without evidence",
		"live provider calls",
		"real credentials",
		"customer data",
	]
	scenarios: [...#Scenario] & list.MinItems(6)
	handoffs:  [...#Handoff] & list.MinItems(7)
}

MarketplaceTrustCopyStates: #MarketplaceTrustCopyStates
MarketplaceTrustCopyScenario: #Scenario
MarketplaceTrustCopy: #Copy
MarketplaceAccessibilityNote: #AccessibilityNote
MarketplaceTrustHandoff: #Handoff
MarketplaceTrustQuickstartFixtureReference: #QuickstartRef
