package architecture_evidence

#EvidenceStatus: "accepted" | "pending" | "rejected"

#EvidenceChannelKind: "logs" | "traces" | "status-views" | "support-debug" | "rollback-signals"

#RequiredEvidence: {
	id:              string & !=""
	owner_project:   string & !=""
	evidence_source: string & !=""
	proves:          string & !=""
	status:          #EvidenceStatus
}

#PrivateBetaScenario: {
	id:                      "hosted-yard-preview-path" | "self-hosted-seed-handover" | "yard-upgrade-and-rollback" | "incident-debug-and-restore"
	yard_mode:               "hosted" | "self-hosted" | "hosted-or-self-hosted"
	beta_cohort:             string & !=""
	fixture_ids:             [...string]
	evidence_channels:       [...#EvidenceChannelKind]
	exit_criteria:           [...string]
	support_handoff:         string & !=""
	uses_live_customer_data: false
	calls_live_providers:    false
}

#EvidenceChannel: {
	id:               #EvidenceChannelKind
	owner_project:    string & !=""
	redaction_rule:   string & !=""
	private_beta_use: string & !=""
}

#RecordedBlocker: {
	id:                 string & !=""
	category:           "beta-blocker" | "launch-note" | "carried-forward"
	owner_project:      string & !=""
	source_evidence_id: string & !=""
	disposition:        string & !=""
	launch_risk:        "low" | "medium" | "high"
}

#AcceptedRisk: {
	id:                       string & !=""
	owner_role:               string & !=""
	mitigation:               string & !=""
	follow_up_or_launch_note: string & !=""
	revisit_date:             string & !=""
	evidence_id:              string & !=""
}

#CrossProjectDependency: {
	owner_project:       string & !=""
	consumes_evidence_id: string & !=""
	cutline_impact:      string & !=""
}

#MissingEvidence: {
	id:                 string & !=""
	owner_project:      string & !=""
	reason:             string & !=""
	launch_disposition: "follow-up" | "release-candidate" | "ga-handoff"
}

#FollowUpIssue: {
	id:                  string & !=""
	owner_project:       string & !=""
	missing_evidence_id: string & !=""
	allowed_reason:      string & !=""
}

#ParentInitiativeSync: {
	initiative:            "HoBo v1 Release Readiness"
	launch_risk_changed:  bool
	status_updated:       bool
	status_update_reason: string & !=""
}

#DogfoodYardPrivateBetaEvidence: {
	issue:                      "HOBO-462"
	parent_issue:               "HOBO-403"
	phase:                      "M2"
	milestone_gate:             "M2 Private beta proof"
	required_evidence:          [...#RequiredEvidence]
	scenarios:                  [...#PrivateBetaScenario]
	evidence_channels:          [...#EvidenceChannel]
	blockers:                   [...#RecordedBlocker]
	accepted_risks:             [...#AcceptedRisk]
	cross_project_dependencies: [...#CrossProjectDependency]
	missing_evidence:           [...#MissingEvidence]
	follow_up_issues:           [...#FollowUpIssue]
	parent_initiative_sync:     #ParentInitiativeSync
}
