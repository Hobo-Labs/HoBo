// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#LaunchSupportGaEvidenceStatus: "unspecified" | "accepted" | "accepted-risk" | "missing"

#LaunchSupportGaBlockerState: "unspecified" | "cleared" | "accepted-risk"

#LaunchSupportGaEvidenceItem: {
	id:                string & !=""
	owner_project:     string & !=""
	source:            string & !=""
	proof_mode:        "design-record" | "issue-state" | "manual-review" | "release-cutline" | "support-handoff"
	status:            #LaunchSupportGaEvidenceStatus
	acceptance_bullet: string & !=""
}

#LaunchSupportGaBlocker: {
	id:                 string & !=""
	owner_project:      string & !=""
	state:              #LaunchSupportGaBlockerState
	source_evidence_id: string & !=""
	disposition:        string & !=""
}

#LaunchSupportGaAcceptedRisk: {
	id:                 string & !=""
	owner_project:      string & !=""
	mitigation:         string & !=""
	launch_risk_effect: "unchanged" | "reduced"
}

#LaunchSupportGaReleaseCutlineDependency: {
	id:               string & !=""
	owner_project:    string & !=""
	readiness_domain: "support" | "operations-readiness" | "incident-communications" | "security" | "release-cutline"
	cutline_category: string & =~"^v1-blocker\\."
	source:           string & !=""
}

#LaunchSupportGaMissingEvidence: {
	id:            string & !=""
	owner_project: string & !=""
	reason:        string & !=""
}

#LaunchSupportGaFollowUp: {
	id:            string & =~"^HOBO-[0-9]+$"
	evidence_id:   string & !=""
	owner_project: string & !=""
	reason:        string & !=""
}

#LaunchSupportGaInitiativeStatusGate: {
	parent_initiative:      "HoBo v1 Release Readiness"
	launch_risk_change:    "unchanged" | "reduced"
	status_update_required: bool
	update_source:          string & !=""
	status_update_url:      string & =~"^https://linear\\.app/.+initiative-update-bb231636"
}

#LaunchSupportGaPublicClaimGuard: {
	id:          string & !=""
	claim:       string & !=""
	evidence_id: string & !=""
	disposition: "hold" | "draft" | "publish"
}

#LaunchSupportGaHandoffEvidenceRecord: {
	schema:                       "hobo.launch-support-ga-handoff-evidence/2026-06-30"
	issue:                        "HOBO-481"
	project:                      "V1 Launch Support Desk & Escalation"
	phase:                        "M4"
	milestone:                    "M4 GA handoff"
	evidence:                     [...#LaunchSupportGaEvidenceItem]
	blockers:                     [...#LaunchSupportGaBlocker]
	accepted_risks:               [...#LaunchSupportGaAcceptedRisk]
	release_cutline_dependencies: [...#LaunchSupportGaReleaseCutlineDependency]
	missing_evidence:             [...#LaunchSupportGaMissingEvidence]
	follow_ups:                   [...#LaunchSupportGaFollowUp]
	initiative_status:            #LaunchSupportGaInitiativeStatusGate
	scope_out:                    [...string]
	public_claim_guards:          [...#LaunchSupportGaPublicClaimGuard]
}
