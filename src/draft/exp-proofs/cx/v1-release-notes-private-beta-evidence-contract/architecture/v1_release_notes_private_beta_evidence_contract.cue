package architecture_evidence

#PrivateBetaEvidenceStatus: "accepted" | "accepted-substitute" | "missing"

#RequiredPrivateBetaEvidence: {
	id:             string & !=""
	status:         #PrivateBetaEvidenceStatus
	owning_project: string & !=""
	proof_source:   [...string] & [_, ...]
	feeds:          [...string] & [_, ...]
}

#RecordedBlocker: {
	id:      string & !=""
	status:  "none-open" | "open" | "accepted-risk"
	owner:   string & !=""
	summary: string & !=""
}

#AcceptedRisk: {
	id:           string & !=""
	owner:        string & !=""
	mitigation:   string & !=""
	revisit_gate: string & !=""
}

#ReleaseCutlineDependency: {
	project:         string & !=""
	issue_or_record: string & !=""
	cutline_role:    string & !=""
}

#ReleaseNotesPrivateBetaEvidenceRecord: {
	issue:                         "HOBO-466"
	project:                       "V1 Release Notes & Upgrade Guide"
	phase:                         "M2"
	milestone_gate:                "M2 Private beta proof"
	required_evidence:             [...#RequiredPrivateBetaEvidence] & [_, ...]
	blockers:                      [...#RecordedBlocker] & [_, ...]
	accepted_risks:                [...#AcceptedRisk] & [_, ...]
	release_cutline_dependencies:  [...#ReleaseCutlineDependency] & [_, ...]
	parent_initiative:             "HoBo v1 Release Readiness"
	gate_changes_launch_risk:      bool
	status_update_evidence:        string & !=""
}
