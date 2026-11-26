package customer_onboarding_scope

import "list"

#CustomerOnboardingScope: {
	issue:   "HOBO-449"
	project: "Customer Onboarding"
	state:   #CustomerOnboardingState
	goal:    =~"Customer Onboarding"
	personas: [...#CustomerOnboardingPersona] & list.MinItems(5)
	operating_boundaries: [...#CustomerOnboardingBoundary] & list.MinItems(4)
	m1_evidence: [...#CustomerOnboardingEvidence] & list.MinItems(6)
	scope_in: [...string] & list.MinItems(1)
	scope_out: [...string] & list.MinItems(1)
	onboarding_stages: [...#CustomerOnboardingStage] & list.MinItems(6)
}

#CustomerOnboardingPersona: {
	id:   =~"^[a-z0-9-]+$"
	need: string & != ""
}

#CustomerOnboardingBoundary: {
	id:      "service" | "ux" | "security" | "support"
	owner:   string & != ""
	promise: string & != ""
}

#CustomerOnboardingEvidence: {
	id:            =~"^[a-z0-9-]+$"
	owner:         string & != ""
	minimum_proof: string & != ""
}

#CustomerOnboardingStage: {
	id:       =~"^[a-z0-9-]+$"
	owner:    string & != ""
	evidence: string & != ""
}

#CustomerOnboardingState: "SCOPE_DRAFT" | "SCOPE_ACCEPTED" | "FOLLOW_UP_BLOCKED"
