package architecture_evidence

#ReleaseNotesGaHandoffEvidence: {
	issue:                         "HOBO-480"
	project:                       "V1 Release Notes & Upgrade Guide"
	phase:                         "M4"
	milestone:                     "M4 GA handoff"
	evidence:                      [...#EvidenceItem]
	blockers:                      [...#Blocker]
	accepted_risks:                [...#AcceptedRisk]
	release_cutline_dependencies:  [...#ReleaseCutlineDependency]
	missing_evidence:              [...#MissingEvidence]
	follow_ups:                    [...#FollowUpIssue]
	initiative_status:             #InitiativeStatus
	scope_out:                     [...string]
	public_claim_guards:           [...#PublicClaimGuard]
}

#EvidenceItem: {
	id:                string & !=""
	owner_project:     string & !=""
	source:            string & !=""
	proof_mode:        "design-record" | "issue-state" | "manual-review" | "release-cutline"
	status:            "accepted" | "accepted-risk" | "missing"
	acceptance_bullet: string & !=""
}

#Blocker: {
	id:                 string & !=""
	owner_project:      string & !=""
	state:              "cleared" | "accepted-risk"
	source_evidence_id: string & !=""
	disposition:        string & !=""
}

#AcceptedRisk: {
	id:                 string & !=""
	owner_project:      string & !=""
	mitigation:         string & !=""
	launch_risk_effect: "unchanged" | "reduced"
}

#ReleaseCutlineDependency: {
	id:                string & !=""
	owner_project:     string & !=""
	readiness_domain:  "documentation" | "release-cutline" | "operations-readiness" | "support" | "compatibility" | "migration"
	cutline_category:  string & =~"^v1-blocker\\."
	source:            string & !=""
}

#MissingEvidence: {
	id:            string & !=""
	owner_project: string & !=""
	reason:        string & !=""
}

#FollowUpIssue: {
	id:            string & !=""
	evidence_id:   string & !=""
	owner_project: string & !=""
	reason:        string & !=""
}

#InitiativeStatus: {
	parent_initiative:      "HoBo v1 Release Readiness"
	launch_risk_change:    "unchanged" | "reduced"
	status_update_required: bool
	update_source:          string & !=""
}

#PublicClaimGuard: {
	id:          string & !=""
	claim:       string & !=""
	evidence_id: string & !=""
	disposition: "hold" | "draft" | "publish"
}
