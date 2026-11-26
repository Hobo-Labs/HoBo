// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#LaunchSupportReleaseCandidateEvidenceStatus: "unspecified" | "accepted" | "accepted-risk" | "missing"

#LaunchSupportReleaseCandidateBlockerState: "unspecified" | "blocked" | "accepted-risk" | "cleared"

#LaunchSupportReleaseCandidateEvidenceItem: {
	id:                string & !=""
	owner_project:     string & !=""
	source:            string & !=""
	proof_mode:        "design-record" | "issue-state" | "manual-review" | "support-drill"
	status:            #LaunchSupportReleaseCandidateEvidenceStatus
	acceptance_bullet: string & !=""
}

#LaunchSupportReleaseCandidateBlocker: {
	id:                 string & !=""
	owner_project:      string & !=""
	state:              #LaunchSupportReleaseCandidateBlockerState
	source_evidence_id: string & !=""
	disposition:        string & !=""
}

#LaunchSupportReleaseCandidateAcceptedRisk: {
	id:                 string & !=""
	owner_project:      string & !=""
	mitigation:         string & !=""
	launch_risk_effect: "unchanged" | "increased" | "reduced"
}

#LaunchSupportReleaseCutlineDependency: {
	id:                string & !=""
	owner_project:     string & !=""
	readiness_domain:  "support" | "operations-readiness" | "documentation" | "security" | "release-cutline"
	cutline_category:  string & =~"^v1-blocker\\."
	source:            string & !=""
}

#LaunchSupportReleaseCandidateFollowUp: {
	id:            string & =~"^HOBO-[0-9]+$"
	evidence_id:   string & !=""
	owner_project: string & !=""
	reason:        string & !=""
}

#LaunchSupportInitiativeStatusGate: {
	parent_initiative:      "HoBo v1 Release Readiness"
	launch_risk_change:    "unchanged" | "increased" | "reduced"
	status_update_required: bool
	update_source:          string & !=""
}

#LaunchSupportPublicClaimGuard: {
	id:          string & !=""
	claim:       string & !=""
	evidence_id: string & !=""
	disposition: "hold" | "draft" | "publish"
}

#LaunchSupportReleaseCandidateEvidenceRecord: {
	issue:                         "HOBO-474"
	project:                       "V1 Launch Support Desk & Escalation"
	phase:                         "M3"
	milestone:                     "M3 Release candidate"
	evidence:                      [...#LaunchSupportReleaseCandidateEvidenceItem]
	blockers:                      [...#LaunchSupportReleaseCandidateBlocker]
	accepted_risks:                [...#LaunchSupportReleaseCandidateAcceptedRisk]
	release_cutline_dependencies:  [...#LaunchSupportReleaseCutlineDependency]
	follow_ups:                    [...#LaunchSupportReleaseCandidateFollowUp]
	initiative_status:             #LaunchSupportInitiativeStatusGate
	scope_out:                     [...string]
	public_claim_guards:           [...#LaunchSupportPublicClaimGuard]
}
