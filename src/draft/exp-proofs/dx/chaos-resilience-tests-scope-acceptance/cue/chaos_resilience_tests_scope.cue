package chaos_resilience_tests_scope

import "list"

#ChaosResilienceTestsScope: {
	issue:   "HOBO-439"
	project: "Chaos & Resilience Tests"
	state:   #ChaosResilienceState
	goal:    =~"Chaos & Resilience Tests"
	personas: [...#ChaosResiliencePersona] & list.MinItems(5)
	operating_boundaries: [...#ChaosResilienceBoundary] & list.MinItems(4)
	m1_evidence: [...#ChaosResilienceEvidence] & list.MinItems(6)
	scope_in: [...string] & list.MinItems(1)
	scope_out: [...string] & list.MinItems(1)
}

#ChaosResiliencePersona: {
	id:   =~"^[a-z0-9-]+$"
	need: string & != ""
}

#ChaosResilienceBoundary: {
	id:      "service" | "ux" | "security" | "support"
	owner:   string & != ""
	promise: string & != ""
}

#ChaosResilienceEvidence: {
	id:            =~"^[a-z0-9-]+$"
	owner:         string & != ""
	minimum_proof: string & != ""
}

#ChaosResilienceState: "SCOPE_DRAFT" | "SCOPE_ACCEPTED" | "FOLLOW_UP_BLOCKED"
