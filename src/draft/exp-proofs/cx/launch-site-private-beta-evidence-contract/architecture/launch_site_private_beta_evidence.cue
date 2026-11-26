// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#LaunchSitePrivateBetaEvidenceStatus: "unspecified" | "accepted" | "missing" | "pending"

#LaunchSitePrivateBetaProofMode: "unspecified" | "design-record" | "manual-review" | "reference-fixture" | "live-recording"

#LaunchSitePrivateBetaEvidenceItem: {
	id:              string & !=""
	owner_project:   string & !=""
	evidence_source: string & !=""
	proves:          string & !=""
	status:          #LaunchSitePrivateBetaEvidenceStatus
}

#LaunchSitePrivateBetaDemoAsset: {
	kind:               "claim-index" | "demo-script" | "command-transcript" | "screenshot-set" | "recording-manifest"
	owner_project:      string & !=""
	proof_mode:         #LaunchSitePrivateBetaProofMode
	refresh_trigger:    string & !=""
	source_evidence_id: string & !=""
	private_beta_only:  true
}

#LaunchSitePrivateBetaFollowUpIssue: {
	id:                  string & !=""
	owner_project:       string & !=""
	missing_evidence_id: string & !=""
	allowed_reason:      string & !=""
}

#LaunchSitePrivateBetaBlocker: {
	id:                 string & !=""
	category:           string & !=""
	owner_project:      string & !=""
	source_evidence_id: string & !=""
	disposition:        string & !=""
}

#LaunchSitePrivateBetaAcceptedRisk: {
	id:            string & !=""
	owner_project: string & !=""
	mitigation:    string & !=""
	launch_note:   string & !=""
}

#LaunchSitePrivateBetaCrossProjectDependency: {
	owner_project: string & !=""
	dependency:    string & !=""
}

#LaunchSitePrivateBetaMissingEvidence: {
	id:            string & !=""
	owner_project: string & !=""
	reason:        string & !=""
}

#LaunchSitePrivateBetaEvidenceRecord: {
	issue:                            "HOBO-465"
	project:                          "V1 Launch Site, Messaging & Demo Assets"
	phase:                            "M2"
	milestone_gate:                   "M2 Private beta proof"
	required_evidence:                [...#LaunchSitePrivateBetaEvidenceItem]
	demo_assets:                      [...#LaunchSitePrivateBetaDemoAsset]
	follow_up_issues:                 [...#LaunchSitePrivateBetaFollowUpIssue]
	blockers:                         [...#LaunchSitePrivateBetaBlocker]
	accepted_risks:                   [...#LaunchSitePrivateBetaAcceptedRisk]
	cross_project_dependencies:       [...#LaunchSitePrivateBetaCrossProjectDependency]
	missing_evidence:                 [...#LaunchSitePrivateBetaMissingEvidence]
	private_beta_publication_allowed: true
	public_or_ga_promotion_allowed:   false
	parent_status_updated:            true
}
