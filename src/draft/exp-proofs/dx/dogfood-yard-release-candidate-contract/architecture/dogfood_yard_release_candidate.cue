package dogfood_yard_release_candidate

import "list"

#EvidenceStatus: "accepted" | "accepted-risk" | "missing"
#ProofMode: "design-record" | "reference-fixture" | "mocked-drill" | "manual-review" | "live-recording"
#LaunchRiskEffect: "unchanged" | "increased" | "reduced"

#EvidenceItem: {
	id:                =~"^[a-z0-9][a-z0-9-]+$"
	owner_project:     string & != ""
	source:            string & != ""
	proof_mode:        #ProofMode
	status:            #EvidenceStatus
	acceptance_bullet: string & != ""
}

#Blocker: {
	id:              =~"^[a-z0-9][a-z0-9-]+$"
	owner_project:   string & != ""
	state:           "accepted-risk" | "blocked" | "release-note"
	evidence_source: string & != ""
	mitigation:      string & != ""
}

#AcceptedRisk: {
	id:                 =~"^[a-z0-9][a-z0-9-]+$"
	owner_project:      string & != ""
	mitigation:         string & != ""
	launch_risk_effect: #LaunchRiskEffect
}

#ReleaseCutlineDependency: {
	id:               =~"^[a-z0-9][a-z0-9-]+$"
	owner_project:    string & != ""
	readiness_domain: "operations-readiness" | "documentation" | "support" | "reliability"
	cutline_category: =~"^v1-blocker\\."
	source:           string & != ""
}

#FollowUp: {
	id:            =~"^(HOBO-[0-9]+|[a-z0-9][a-z0-9-]+)$"
	evidence_id:   string & != ""
	owner_project: string & != ""
	disposition:   "existing-issue" | "new-issue-required"
	reason:        string & != ""
}

#InitiativeStatus: {
	parent_initiative:      "HoBo v1 Release Readiness"
	launch_risk_change:    #LaunchRiskEffect
	status_update_required: bool
	update_source:          string
	if launch_risk_change != "unchanged" {
		status_update_required: true
		update_source:          string & != ""
	}
}

#OperationalClaimGuard: {
	id:          =~"^[a-z0-9][a-z0-9-]+$"
	claim:       string & != ""
	evidence_id: string & != ""
	disposition: "hold" | "release-candidate" | "publish"
}

#DogfoodYardReleaseCandidateEvidence: {
	schema:    =~"^hobo\\.dogfood-yard\\.release-candidate/"
	issue:     "HOBO-469"
	project:   "V1 Dogfood Yard & Hosted Operations"
	phase:     "M3"
	milestone: "M3 Release candidate"
	evidence: [...#EvidenceItem] & list.MinItems(6)
	blockers: [...#Blocker] & list.MinItems(2)
	accepted_risks: [...#AcceptedRisk] & list.MinItems(2)
	release_cutline_dependencies: [...#ReleaseCutlineDependency] & list.MinItems(4)
	follow_ups:               [...#FollowUp]
	initiative_status:        #InitiativeStatus
	scope_out:                [...string]
	operational_claim_guards: [...#OperationalClaimGuard]
}
