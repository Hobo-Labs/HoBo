package v1_beta_pilot_private_beta_evidence

#EvidenceStatus: "complete" | "missing" | "accepted-limitation"
#BlockerStatus: "open" | "resolved" | "accepted-limitation"

#RequiredEvidence: {
	id:             =~"^[a-z0-9-]+$"
	owner_project: string & != ""
	evidence_kinds: [...string] & [_, ...]
	status:         #EvidenceStatus
}

#BlockerState: {
	id:            =~"^[a-z0-9-]+$"
	status:        #BlockerStatus
	owner_project: string & != ""
	disposition:   string & != ""
}

#AcceptedRisk: {
	id:                       =~"^[a-z0-9-]+$"
	owner:                    string & != ""
	mitigation:               string & != ""
	launch_note_or_follow_up: string & != ""
}

#PrivateBetaEvidenceGate: {
	issue:     "HOBO-463"
	project:   "V1 Beta Pilot & Feedback Loop"
	phase:     "M2"
	milestone: "M2 Private beta proof"
	required_evidence: [...#RequiredEvidence] & [_, _, _, _, ...]
	blocker_states: [...#BlockerState] & [_, ...]
	accepted_risks: [...#AcceptedRisk] & [_, ...]
	release_cutline: {
		consumes_projects: [...string] & [_, ...]
		blocks_release_candidate_without_dependency_disposition: true
	}
	scope_in: [...string] & [_, ...]
	scope_out: [...string] & [_, ...]
}

#ReleaseCutline: {
	consumes_projects: [...string] & [_, ...]
	blocks_release_candidate_without_dependency_disposition: true
}

#PrivateBetaEvidenceGateCommand: {
	gate:         #PrivateBetaEvidenceGate
	requested_by: string & != ""
}

#PrivateBetaEvidenceGateAccepted: {
	gate:                    #PrivateBetaEvidenceGate
	parent_readiness_signal: "risk-increased" | "no-parent-status-change"
}

#PrivateBetaEvidenceGateDenied: {
	errors: [...string] & [_, ...]
}
