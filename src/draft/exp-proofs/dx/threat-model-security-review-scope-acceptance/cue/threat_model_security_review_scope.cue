package threat_model_security_review_scope

import "list"

#ThreatModelSecurityReviewScope: {
	issue:   "HOBO-451"
	project: "Threat Model & Security Review"
	state:   #ThreatReviewState
	goal:    =~"Threat Model & Security Review"
	personas: [...#ThreatReviewPersona] & list.MinItems(5)
	operating_boundaries: [...#ThreatReviewBoundary] & list.MinItems(4)
	intake_fields: [...#ThreatReviewIntakeField] & list.MinItems(8)
	review_gates: [...#ThreatReviewGate] & list.MinItems(5)
	scope_in: [...string] & list.MinItems(1)
	scope_out: [...string] & list.MinItems(1)
}

#ThreatReviewPersona: {
	id:   =~"^[a-z0-9-]+$"
	need: string & != ""
}

#ThreatReviewBoundary: {
	id:      "service" | "ux" | "security" | "support"
	owner:   string & != ""
	promise: string & != ""
}

#ThreatReviewIntakeField: {
	id:            =~"^[a-z0-9-]+$"
	owner:         string & != ""
	minimum_proof: string & != ""
}

#ThreatReviewGate: {
	id:            =~"^[a-z0-9-]+$"
	owner:         string & != ""
	minimum_proof: string & != ""
}

#ThreatReviewState: "SCOPE_DRAFT" | "SCOPE_ACCEPTED" | "FOLLOW_UP_BLOCKED"
