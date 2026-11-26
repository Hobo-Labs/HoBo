package security_verification_scope

import "list"

#SecurityVerificationScope: {
	issue:   "HOBO-441"
	project: "Security Verification"
	state:   #SecurityVerificationState
	goal:    =~"Security Verification"
	personas: [...#SecurityVerificationPersona] & list.MinItems(5)
	operating_boundaries: [...#SecurityVerificationBoundary] & list.MinItems(4)
	m1_evidence: [...#SecurityVerificationEvidence] & list.MinItems(6)
	scope_in: [...string] & list.MinItems(1)
	scope_out: [...string] & list.MinItems(1)
}

#SecurityVerificationPersona: {
	id:   =~"^[a-z0-9-]+$"
	need: string & != ""
}

#SecurityVerificationBoundary: {
	id:      "service" | "ux" | "security" | "support"
	owner:   string & != ""
	promise: string & != ""
}

#SecurityVerificationEvidence: {
	id:            =~"^[a-z0-9-]+$"
	owner:         string & != ""
	minimum_proof: string & != ""
}

#SecurityVerificationState: "SCOPE_DRAFT" | "SCOPE_ACCEPTED" | "FOLLOW_UP_BLOCKED"
