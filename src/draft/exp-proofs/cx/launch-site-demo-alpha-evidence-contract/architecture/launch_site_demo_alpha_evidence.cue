// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#LaunchSiteDemoEvidenceStatus: "unspecified" | "accepted" | "accepted-risk" | "missing"

#LaunchSiteDemoProofMode: "unspecified" | "design-record" | "reference-fixture" | "live-recording" | "manual-review"

#LaunchSiteDemoLaunchRiskEffect: "unspecified" | "unchanged" | "increased" | "reduced"

#LaunchSiteDemoEvidenceItem: {
	id:                string & !=""
	owner_project:     string & !=""
	source:            string & !=""
	proof_mode:        #LaunchSiteDemoProofMode
	status:            #LaunchSiteDemoEvidenceStatus
	acceptance_bullet: string & !=""
}

#LaunchSiteDemoBlocker: {
	id:              string & !=""
	owner_project:   string & !=""
	state:           "accepted-risk" | "blocked"
	evidence_source: string & !=""
	mitigation:      string & !=""
}

#LaunchSiteDemoAcceptedRisk: {
	id:                 string & !=""
	owner_project:      string & !=""
	mitigation:         string & !=""
	launch_risk_effect: #LaunchSiteDemoLaunchRiskEffect
}

#LaunchSiteDemoReleaseCutlineDependency: {
	id:                string & !=""
	owner_project:     string & !=""
	readiness_domain:  "documentation" | "productization" | "operations-readiness"
	cutline_category:  =~"^v1-blocker\\."
	source:            string & !=""
}

#LaunchSiteDemoFollowUp: {
	id:            string & !=""
	evidence_id:   string & !=""
	owner_project: string & !=""
	reason:        string & !=""
}

#LaunchSiteDemoInitiativeStatusGate: {
	parent_initiative:      "HoBo v1 Release Readiness"
	launch_risk_change:    #LaunchSiteDemoLaunchRiskEffect
	status_update_required: bool
	update_source:          string
}

#LaunchSiteDemoPublicClaimGuard: {
	id:          string & !=""
	claim:       string & !=""
	evidence_id: string & !=""
	disposition: "hold" | "draft" | "publish"
}

#LaunchSiteDemoAlphaEvidenceRecord: {
	issue:                         "HOBO-458"
	project:                       "V1 Launch Site, Messaging & Demo Assets"
	phase:                         "M1"
	milestone:                     "M1 Dogfood/alpha proof"
	evidence:                      [...#LaunchSiteDemoEvidenceItem]
	blockers:                      [...#LaunchSiteDemoBlocker]
	accepted_risks:                [...#LaunchSiteDemoAcceptedRisk]
	release_cutline_dependencies:  [...#LaunchSiteDemoReleaseCutlineDependency]
	follow_ups:                    [...#LaunchSiteDemoFollowUp]
	initiative_status:             #LaunchSiteDemoInitiativeStatusGate
	scope_out:                     [...string]
	public_claim_guards:           [...#LaunchSiteDemoPublicClaimGuard]
}
