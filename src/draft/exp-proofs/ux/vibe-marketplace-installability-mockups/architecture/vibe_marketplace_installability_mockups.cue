package vibe_marketplace_installability_mockups

#MarketplacePersona: "app developer" | "workspace administrator" | "marketplace operator" | "security reviewer" | "support operator"
#MarketplaceSurface: "browse" | "search" | "listing-detail" | "installability-panel"
#MarketplaceState: "preview-only" | "limited-beta" | "installable" | "policy-blocked" | "deprecated" | "yanked"
#MarketplaceScenario: "happy-path" | "blocked-path" | "stale-or-unknown-evidence" | "support-handoff"
#MarketplaceProofMode: "live" | "simulated" | "reference fixture" | "scope-out"

#VibeMarketplaceInstallabilityMockups: {
	issue: "HOBO-546"
	phase: "M1"
	packagePath: "src/draft/exp-proofs/ux/vibe-marketplace-installability-mockups"
	proofPath: "docs/design/proofs/vibe-marketplace-installability-mockups/README.md"
	designRefs: [...string]
	quickstartFixtureRefs: [...#MarketplaceQuickstartFixtureReference]
	personas: [...#MarketplacePersona]
	wireframes: [...#MarketplaceWireframe]
	fixtures: [...#MarketplaceListingFixture]
	scenarioPaths: [...#MarketplaceScenarioPath]
	accessibilityNotes: [...=~"^.+$"] & [_, ...]
	scopeOut: [...string]
}

#MarketplaceQuickstartFixtureReference: {
	sourceIssue: "HOBO-577"
	fixtureId: =~"^rlq-"
	proofMode: "reference-fixture" | "simulated" | "live" | "scope-out"
	consumingSurface: #MarketplaceSurface
	marketplaceUse: string & != ""
}

#MarketplaceWireframe: {
	id: =~"^wf-marketplace-"
	surface: #MarketplaceSurface
	title: string & != ""
	personas: [...#MarketplacePersona] & [_, ...]
	questionsAnswered: [...=~"^.{20,}$"] & [_, ...]
	fixtureIds: [...=~"^hobo-546-marketplace-"] & [_, ...]
}

#MarketplaceListingFixture: {
	state: #MarketplaceState
	fixtureId: =~"^hobo-546-marketplace-"
	visibleState: string & != ""
	evidenceSource: =~"^docs/design/"
	ownerRoute: string & != ""
	customerSafeMessage: string & != ""
	orgCatalogDisposition: string & != ""
	proofMode: #MarketplaceProofMode
	trustEvidence: string & != ""
	supportHandoff: string & != ""
}

#MarketplaceScenarioPath: {
	id: #MarketplaceScenario
	narrative: string & != ""
	fixtureIds: [...=~"^hobo-546-marketplace-"] & [_, ...]
	proofModeLabels: [...#MarketplaceProofMode] & [_, ...]
	accessibilityNote: string & != ""
	safeOutcome: string & != ""
}
