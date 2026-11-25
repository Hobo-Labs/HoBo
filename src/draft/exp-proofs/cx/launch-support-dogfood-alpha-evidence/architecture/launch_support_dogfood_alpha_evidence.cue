// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#LaunchSupportEvidenceStatus: "unspecified" | "accepted" | "missing-follow-up"

#LaunchSupportFindingClassification: "unspecified" | "accepted-risk" | "launch-note" | "post-ga-follow-up" | "launch-blocker"

#LaunchSupportEvidenceRecord: {
	id:              string & !=""
	owner_project:   string & !=""
	source:          string & =~"^docs/design/"
	proves:          string & !=""
	status:          #LaunchSupportEvidenceStatus
	follow_up_title: string
	blocks_launch:   bool
}

#LaunchSupportFindingRecord: {
	id:                 string & !=""
	source_evidence_id: string & !=""
	classification:     #LaunchSupportFindingClassification
	owner_project:      string & !=""
	blocks_launch:      bool
	mitigation:         string
	expiry:             string
}

#LaunchSupportDependencyRecord: {
	owner_project:   string & !=""
	cutline_ref:     string & =~"^docs/design/"
	required_for_m1: bool
	consumes:        string & !=""
}

#LaunchSupportDogfoodAlphaRecord: {
	issue:        "HOBO-460"
	phase:        "M1"
	project:      "V1 Launch Support Desk & Escalation"
	evidence:     [...#LaunchSupportEvidenceRecord]
	findings:     [...#LaunchSupportFindingRecord]
	dependencies: [...#LaunchSupportDependencyRecord]
}
