package dx_resource_lifecycle_scenario_matrix

import "list"

#RequiredRole: "app-developer" | "platform-engineer" | "gitops" | "secops" | "devops" | "sre" | "agent-mcp-caller"
#RequiredPath: "happy-path" | "blocked-path" | "stale-or-unknown-evidence" | "migration-or-rollback" | "support-handoff"
#ProofMode: "command-transcript" | "contract-fixture" | "projection-snapshot" | "support-safe-evidence"

#DxScenarioJourney: {
	id:                  =~"^[a-z0-9][a-z0-9-]+$"
	role:                #RequiredRole
	intent:              string & =~"\\S"
	commands:            [...string] & list.MinItems(1)
	sdkCalls:            [...string] & list.MinItems(1)
	apiCalls:            [...string] & list.MinItems(1)
	mcpTools:            [...string] & list.MinItems(1)
	expectedArtifacts:   [...string] & list.MinItems(1)
	proofMode:           #ProofMode
	fixtureRequirements: [...string] & list.MinItems(1)
	scenarioPaths:       [#RequiredPath, #RequiredPath, #RequiredPath, #RequiredPath, #RequiredPath]
	designTerms:         [...string] & list.MinItems(1)
}

#DxResourceLifecycleScenarioMatrix: {
	issue:          "HOBO-567"
	phase:          "M1"
	targetPackage:  "src/draft/exp-proofs/dx/dx-resource-lifecycle-scenario-matrix"
	proofNote:      "docs/design/proofs/dx-resource-lifecycle-scenario-matrix/README.md"
	designRefs:     [...string] & list.MinItems(1)
	designTerms:    [...string] & list.MinItems(1)
	scopeOut: [
		"production CLI/API/SDK implementation",
		"live providers",
		"real credentials",
		"customer data",
		"visual mockups that invent resource behavior before the matrix exists",
	]
	journeys: [...#DxScenarioJourney] & list.MinItems(7)
}
