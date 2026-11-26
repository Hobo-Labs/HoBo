// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#LaunchSiteReleaseCandidateEvidenceStatus: "unspecified" | "accepted" | "accepted-risk" | "missing"

#LaunchSiteReleaseCandidateProofMode: "unspecified" | "design-record" | "issue-state" | "manual-review" | "reference-fixture" | "live-recording"

#LaunchSiteReleaseCandidateLaunchRiskEffect: "unspecified" | "unchanged" | "increased" | "reduced"

#LaunchSiteReleaseCandidateEvidenceItem: {
	id:                string & !=""
	owner_project:     string & !=""
	source:            string & !=""
	proof_mode:        #LaunchSiteReleaseCandidateProofMode
	status:            #LaunchSiteReleaseCandidateEvidenceStatus
	acceptance_bullet: string & !=""
}

#LaunchSiteReleaseCandidateBlocker: {
	id:                 string & !=""
	owner_project:      string & !=""
	state:              "blocked" | "accepted-risk" | "cleared"
	source_evidence_id: string & !=""
	disposition:        string & !=""
}

#LaunchSiteReleaseCandidateAcceptedRisk: {
	id:                 string & !=""
	owner_project:      string & !=""
	mitigation:         string & !=""
	launch_risk_effect: #LaunchSiteReleaseCandidateLaunchRiskEffect
}

#LaunchSiteReleaseCutlineDependency: {
	id:                string & !=""
	owner_project:     string & !=""
	readiness_domain:  "documentation" | "productization" | "operations-readiness" | "support" | "legal" | "release-cutline"
	cutline_category:  =~"^v1-blocker\\."
	source:            string & !=""
}

#LaunchSiteReleaseCandidateFollowUp: {
	id:            string & !=""
	evidence_id:   string & !=""
	owner_project: string & !=""
	reason:        string & !=""
}

#LaunchSiteInitiativeStatusGate: {
	parent_initiative:      "HoBo v1 Release Readiness"
	launch_risk_change:    #LaunchSiteReleaseCandidateLaunchRiskEffect
	status_update_required: bool
	update_source:          string
}

#LaunchSitePublicClaimGuard: {
	id:          string & !=""
	claim:       string & !=""
	evidence_id: string & !=""
	disposition: "hold" | "draft" | "publish"
}

#LaunchSiteReleaseCandidateEvidenceRecord: {
	issue:                        "HOBO-472"
	project:                      "V1 Launch Site, Messaging & Demo Assets"
	phase:                        "M3"
	milestone:                    "M3 Release candidate"
	evidence:                     [...#LaunchSiteReleaseCandidateEvidenceItem]
	blockers:                     [...#LaunchSiteReleaseCandidateBlocker]
	accepted_risks:               [...#LaunchSiteReleaseCandidateAcceptedRisk]
	release_cutline_dependencies: [...#LaunchSiteReleaseCutlineDependency]
	follow_ups:                   [...#LaunchSiteReleaseCandidateFollowUp]
	initiative_status:            #LaunchSiteInitiativeStatusGate
	scope_out:                    [...string]
	public_claim_guards:          [...#LaunchSitePublicClaimGuard]
}
