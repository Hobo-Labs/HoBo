// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#LaunchSiteGaEvidenceStatus: "unspecified" | "accepted" | "accepted-risk" | "missing"

#LaunchSiteGaProofMode: "unspecified" | "design-record" | "issue-state" | "manual-review" | "live-recording"

#LaunchSiteGaLaunchRiskEffect: "unspecified" | "unchanged" | "increased" | "reduced"

#LaunchSiteGaEvidenceItem: {
	id:                string & !=""
	owner_project:     string & !=""
	source:            string & !=""
	proof_mode:        #LaunchSiteGaProofMode
	status:            #LaunchSiteGaEvidenceStatus
	acceptance_bullet: string & !=""
}

#LaunchSiteGaBlocker: {
	id:                 string & !=""
	owner_project:      string & !=""
	state:              "blocked" | "accepted-risk" | "cleared"
	source_evidence_id: string & !=""
	disposition:        string & !=""
}

#LaunchSiteGaAcceptedRisk: {
	id:                 string & !=""
	owner_project:      string & !=""
	mitigation:         string & !=""
	launch_risk_effect: #LaunchSiteGaLaunchRiskEffect
}

#LaunchSiteGaCutlineDependency: {
	id:               string & !=""
	owner_project:    string & !=""
	readiness_domain: "documentation" | "productization" | "operations-readiness" | "support" | "legal-privacy" | "release-cutline"
	cutline_category: =~"^v1-blocker\\."
	source:           string & !=""
}

#LaunchSiteGaFollowUp: {
	id:            string & !=""
	evidence_id:   string & !=""
	owner_project: string & !=""
	reason:        string & !=""
}

#LaunchSiteGaInitiativeStatusGate: {
	parent_initiative:      "HoBo v1 Release Readiness"
	launch_risk_change:    #LaunchSiteGaLaunchRiskEffect
	status_update_required: bool
	update_source:          string
}

#LaunchSiteGaPublicClaimGuard: {
	id:          string & !=""
	claim:       string & !=""
	evidence_id: string & !=""
	disposition: "hold" | "draft" | "publish"
}

#LaunchSiteGaHandoffEvidenceRecord: {
	issue:                         "HOBO-479"
	project:                       "V1 Launch Site, Messaging & Demo Assets"
	phase:                         "M4"
	milestone:                     "M4 GA handoff"
	evidence:                      [...#LaunchSiteGaEvidenceItem]
	blockers:                      [...#LaunchSiteGaBlocker]
	accepted_risks:                [...#LaunchSiteGaAcceptedRisk]
	release_cutline_dependencies:  [...#LaunchSiteGaCutlineDependency]
	follow_ups:                    [...#LaunchSiteGaFollowUp]
	initiative_status:             #LaunchSiteGaInitiativeStatusGate
	scope_out:                     [...string]
	public_claim_guards:           [...#LaunchSiteGaPublicClaimGuard]
}
