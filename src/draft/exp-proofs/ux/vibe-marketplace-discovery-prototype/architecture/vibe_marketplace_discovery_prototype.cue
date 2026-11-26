package vibe_marketplace_discovery_prototype

import "list"

#ListingState: "preview-only" | "limited-beta" | "installable" | "policy-blocked" | "deprecated" | "yanked"
#Path: "happy-path" | "blocked-path" | "stale-or-unknown-evidence" | "support-handoff"
#ProofMode: "live" | "simulated" | "reference fixture" | "scope-out"
#QuickstartProofMode: "reference-fixture" | "simulated" | "live" | "scope-out"
#Surface: "browse" | "search" | "listing-detail" | "installability-panel"
#TrustCopyState: "preview-warning" | "installable-with-evidence" | "policy-block" | "deprecated-guidance" | "yanked-support-route" | "hidden-listing"

#SourceIssue: {
	issue:       "HOBO-546" | "HOBO-547" | "HOBO-577"
	packagePath: string & =~"^src/draft/exp-proofs/"
	proofPath:   string & =~"^docs/design/proofs/"
}

#SourceMockup: {
	sourceIssue: "HOBO-546"
	fixtureId:   =~"^hobo-546-marketplace-"
	surface:     #Surface
}

#SourceTrustCopy: {
	sourceIssue: "HOBO-547"
	fixtureId:   =~"^mtc-[a-z0-9-]+-v1$"
	copyState:   #TrustCopyState
}

#QuickstartRef: {
	sourceIssue: "HOBO-577"
	fixtureId:   =~"^rlq-"
	proofMode:   #QuickstartProofMode
}

#CatalogFixture: {
	fixtureId:             =~"^mdp-[a-z0-9-]+-v1$"
	listingState:          #ListingState
	displayLabel:          string & =~"\\S"
	sourceMockup:          #SourceMockup
	sourceTrustCopy:       #SourceTrustCopy
	quickstartRef:         #QuickstartRef
	trustEvidence:         string & =~"\\S"
	orgCatalogDecision:    string & =~"\\S"
	supportRoute:          string & =~"\\S"
	installabilityOutcome: string & =~"\\S"
	proofMode:             #ProofMode
	customerSafeMessage:   string & =~"\\S"
	safeNextAction:        string & =~"\\S"
}

#DiscoveryPath: {
	kind:               #Path
	fixtureIds:         [...=~"^mdp-"] & list.MinItems(1)
	proofModes:         [...#ProofMode] & list.MinItems(1)
	expectedUserSignal: string & =~"\\S"
	supportHandoff:     string & =~"\\S"
}

#MarketplaceDiscoveryPrototype: {
	issue:         "HOBO-562"
	phase:         "M2"
	targetPackage: "src/draft/exp-proofs/ux/vibe-marketplace-discovery-prototype"
	proofNote:     "docs/design/proofs/vibe-marketplace-discovery-prototype/README.md"
	designRefs:    [...string] & list.MinItems(1)
	sourceIssues:  [...#SourceIssue] & list.MinItems(3)
	catalog:       [...#CatalogFixture] & list.MinItems(6)
	paths:         [...#DiscoveryPath] & list.MinItems(4)
	accessibilityNotes: [...string] & list.MinItems(5)
	scopeOut: [
		"No live storefront, browse/search service, marketplace service, or production UI.",
		"No Registry storage, registry resolver, package hosting, signing, or install-time verification.",
		"No install runtime, install service, deploy runtime, or live provider action.",
		"No ranking, recommendation, paid placement, monetization, payouts, or marketplace commerce policy.",
		"No publisher workflow, publisher portal UI, evidence upload service, or maintainer workflow.",
		"No policy engine, RBAC runtime, scanner integration, conformance runner, or approval service.",
		"No support queue, support tooling, notification delivery, or live ticket creation.",
		"No public launch publication or launch claims without evidence.",
	]
}

MarketplaceDiscoveryPrototype: #MarketplaceDiscoveryPrototype
VibeMarketplaceDiscoveryPrototype: #MarketplaceDiscoveryPrototype
MarketplaceDiscoverySourceIssue: #SourceIssue
MarketplaceDiscoveryMockupSource: #SourceMockup
MarketplaceDiscoveryTrustCopySource: #SourceTrustCopy
MarketplaceDiscoveryQuickstartRef: #QuickstartRef
MarketplaceDiscoveryCatalogFixture: #CatalogFixture
MarketplaceDiscoveryPath: #DiscoveryPath
