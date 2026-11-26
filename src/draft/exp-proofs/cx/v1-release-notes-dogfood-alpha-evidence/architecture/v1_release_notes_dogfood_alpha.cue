// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#V1ReleaseNotesDogfoodAlphaEvidenceStatus: "unspecified" | "accepted" | "accepted-with-risk" | "missing"

#V1ReleaseNotesDogfoodAlphaEvidenceItem: {
	id:                    string & !=""
	owner_project:         string & !=""
	source_evidence:       string & !=""
	release_note_sections: [...string]
	cutline_category:      =~"^v1-blocker\\."
	status:                #V1ReleaseNotesDogfoodAlphaEvidenceStatus
}

#V1ReleaseNotesDogfoodAlphaBlocker: {
	id:               string & !=""
	owner_project:    string & !=""
	state:            "open" | "resolved" | "accepted-risk"
	accepted_risk_id: string
	mitigation:       string
}

#V1ReleaseNotesDogfoodAlphaAcceptedRisk: {
	id:             string & !=""
	owner_project:  string & !=""
	launch_impact:  string & !=""
	mitigation:     string & !=""
}

#V1ReleaseNotesDogfoodAlphaFollowUp: {
	evidence_id:   string & !=""
	issue:         string & !=""
	owner_project: string & !=""
	reason:        string & !=""
}

#V1ReleaseNotesDogfoodAlphaParentReadinessStatusUpdate: {
	initiative: string & !=""
	status:     "on-track" | "at-risk" | "blocked"
	reason:     string & !=""
}

#V1ReleaseNotesDogfoodAlphaGate: {
	schema:                         string & !=""
	issue:                          "HOBO-459"
	project:                        "V1 Release Notes & Upgrade Guide"
	phase:                          "M1"
	milestone:                      =~"Dogfood/alpha"
	evidence:                       [...#V1ReleaseNotesDogfoodAlphaEvidenceItem]
	blockers:                       [...#V1ReleaseNotesDogfoodAlphaBlocker]
	accepted_risks:                 [...#V1ReleaseNotesDogfoodAlphaAcceptedRisk]
	follow_ups:                     [...#V1ReleaseNotesDogfoodAlphaFollowUp]
	launch_risk_changed:            bool
	parent_readiness_status_update: #V1ReleaseNotesDogfoodAlphaParentReadinessStatusUpdate
}
