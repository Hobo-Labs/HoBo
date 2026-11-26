// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#BetaPilotReleaseCandidateEvidenceStatus: "unspecified" | "accepted" | "accepted-risk" | "missing"

#BetaPilotReleaseCandidateProofMode: "unspecified" | "design-record" | "issue-state" | "manual-review" | "support-triage"

#BetaPilotReleaseCandidateLaunchRiskEffect: "unspecified" | "unchanged" | "increased" | "reduced"

#BetaPilotReleaseCandidateEvidenceItem: {
	id:                string & !=""
	owner_project:     string & !=""
	source:            string & !=""
	proof_mode:        #BetaPilotReleaseCandidateProofMode
	status:            #BetaPilotReleaseCandidateEvidenceStatus
	acceptance_bullet: string & !=""
}

#BetaPilotReleaseCandidateBlocker: {
	id:                 string & !=""
	owner_project:      string & !=""
	state:              "blocked" | "accepted-risk" | "cleared"
	source_evidence_id: string & !=""
	disposition:        string & !=""
}

#BetaPilotReleaseCandidateAcceptedRisk: {
	id:                 string & !=""
	owner_project:      string & !=""
	mitigation:         string & !=""
	launch_risk_effect: #BetaPilotReleaseCandidateLaunchRiskEffect
}

#BetaPilotReleaseCutlineDependency: {
	id:                string & !=""
	owner_project:     string & !=""
	readiness_domain:  "documentation" | "productization" | "support" | "operations-readiness"
	cutline_category:  =~"^v1-blocker\\."
	source:            string & !=""
}

#BetaPilotReleaseCandidateFollowUp: {
	id:            string & !=""
	evidence_id:   string & !=""
	owner_project: string & !=""
	reason:        string & !=""
}

#BetaPilotInitiativeStatusGate: {
	parent_initiative:      "HoBo v1 Release Readiness"
	launch_risk_change:    #BetaPilotReleaseCandidateLaunchRiskEffect
	status_update_required: bool
	update_source:          string
}

#BetaPilotPublicClaimGuard: {
	id:          string & !=""
	claim:       string & !=""
	evidence_id: string & !=""
	disposition: "hold" | "draft" | "publish"
}

#BetaPilotReleaseCandidateEvidenceRecord: {
	issue:                         "HOBO-470"
	project:                       "V1 Beta Pilot & Feedback Loop"
	phase:                         "M3"
	milestone:                     "M3 Release candidate"
	evidence:                      [...#BetaPilotReleaseCandidateEvidenceItem]
	blockers:                      [...#BetaPilotReleaseCandidateBlocker]
	accepted_risks:                [...#BetaPilotReleaseCandidateAcceptedRisk]
	release_cutline_dependencies:  [...#BetaPilotReleaseCutlineDependency]
	follow_ups:                    [...#BetaPilotReleaseCandidateFollowUp]
	initiative_status:             #BetaPilotInitiativeStatusGate
	scope_out:                     [...string]
	public_claim_guards:           [...#BetaPilotPublicClaimGuard]
}
