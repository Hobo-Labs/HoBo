// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#LaunchSupportPrivateBetaEvidenceStatus: "unspecified" | "accepted" | "missing-follow-up"

#LaunchSupportPrivateBetaBlockerCategory: "unspecified" | "launch-limitation" | "security-gate" | "launch-blocker"

#LaunchSupportPrivateBetaEvidenceRecord: {
	id:              string & !=""
	owner_project:   string & !=""
	evidence_source: string & !=""
	proves:          string & !=""
	status:          #LaunchSupportPrivateBetaEvidenceStatus
}

#LaunchSupportPrivateBetaBlockerRecord: {
	id:                 string & !=""
	category:           #LaunchSupportPrivateBetaBlockerCategory
	owner_project:      string & !=""
	source_evidence_id: string & !=""
	disposition:        string & !=""
	launch_risk:        "low" | "medium" | "high"
}

#LaunchSupportPrivateBetaAcceptedRisk: {
	id:                       string & !=""
	owner_role:               string & !=""
	mitigation:               string & !=""
	follow_up_or_launch_note: string & !=""
	revisit_date:             string & =~"^20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]$"
	evidence_id:              string & !=""
}

#LaunchSupportPrivateBetaDependency: {
	owner_project:        string & !=""
	consumes_evidence_id: string & !=""
	cutline_impact:       string & !=""
}

#LaunchSupportPrivateBetaFollowUp: {
	id:                  string & =~"^HOBO-[0-9]+$"
	owner_project:       string & !=""
	missing_evidence_id: string & !=""
	allowed_reason:      string & !=""
}

#LaunchSupportPrivateBetaRecord: {
	issue:                      "HOBO-467"
	phase:                      "M2"
	milestone_gate:             "M2 Private beta proof"
	required_evidence:          [...#LaunchSupportPrivateBetaEvidenceRecord]
	blockers:                   [...#LaunchSupportPrivateBetaBlockerRecord]
	accepted_risks:             [...#LaunchSupportPrivateBetaAcceptedRisk]
	cross_project_dependencies: [...#LaunchSupportPrivateBetaDependency]
	follow_up_issues:           [...#LaunchSupportPrivateBetaFollowUp]
	parent_status_updated:      bool
	public_sla_promised:        false
	implements_support_runtime: false
	uses_customer_data:         false
	implements_ticket_queue:    false
	publishes_status_page:      false
	approves_commercial_terms:  false
}
