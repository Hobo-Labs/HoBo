package architecture_evidence

#HostedBrokerGaHandoffEvidence: {
	issue:                 "HOBO-530"
	project:               "Meta-cloud Broker"
	phase:                 "M4"
	milestone_gate:        string & =~"GA handoff"
	required_evidence:     [...#EvidenceItem]
	dogfood_readiness_links: [...#DogfoodReadinessLink]
	compatibility_windows: [...#CompatibilityWindow]
	rollback_restore_limits: [...string]
	release_and_support_docs: [...string]
	accepted_risks:       [...string]
	missing_evidence:      [...#MissingEvidence]
	follow_up_issues:      [...#FollowUpIssue]
	parent_status_updated: bool
}

#EvidenceItem: {
	id:            string & !=""
	owner_project: string & !=""
	proof_source:  string & !=""
	proves:        string & !=""
	status:        "accepted"
}

#DogfoodReadinessLink: {
	artifact:             string & !=""
	owner_project:        string & !=""
	source_evidence_id:   string & !=""
	deploy_readiness_use: string & !=""
	ga_boundary:          string & !=""
}

#CompatibilityWindow: {
	id:                 string & !=""
	owner_project:      string & !=""
	current_version:    string & !=""
	compatibility_rule: string & !=""
}

#MissingEvidence: {
	id:                 string & !=""
	owner_project:      string & !=""
	reason:             string & !=""
	launch_disposition: "post-ga-follow-up" | "release-owner-decision"
}

#FollowUpIssue: {
	id:                  string & !=""
	owner_project:       string & !=""
	missing_evidence_id: string & !=""
	allowed_reason:      string & !=""
}
