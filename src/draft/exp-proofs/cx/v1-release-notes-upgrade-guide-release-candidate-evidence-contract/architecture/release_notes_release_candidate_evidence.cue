// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#ReleaseNotesReleaseCandidateEvidenceStatus: "unspecified" | "accepted" | "accepted-risk" | "missing"

#ReleaseNotesReleaseCandidateBlockerState: "unspecified" | "blocked" | "accepted-risk" | "cleared"

#ReleaseNotesReleaseCandidateEvidenceItem: {
	id:                string & !=""
	owner_project:     string & !=""
	source:            string & !=""
	proof_mode:        "design-record" | "issue-state" | "manual-review" | "docs-draft" | "cutline-review"
	status:            #ReleaseNotesReleaseCandidateEvidenceStatus
	acceptance_bullet: string & !=""
}

#ReleaseNotesReleaseCandidateBlocker: {
	id:                 string & !=""
	owner_project:      string & !=""
	state:              #ReleaseNotesReleaseCandidateBlockerState
	source_evidence_id: string & !=""
	disposition:        string & !=""
}

#ReleaseNotesReleaseCandidateAcceptedRisk: {
	id:                 string & !=""
	owner_project:      string & !=""
	mitigation:         string & !=""
	launch_risk_effect: "unchanged" | "increased" | "reduced"
}

#ReleaseNotesReleaseCutlineDependency: {
	id:                string & !=""
	owner_project:     string & !=""
	readiness_domain:  "documentation" | "release-cutline" | "operations-readiness" | "support" | "compatibility"
	cutline_category:  string & =~"^v1-blocker\\."
	source:            string & !=""
}

#ReleaseNotesReleaseCandidateFollowUp: {
	id:            string & =~"^HOBO-[0-9]+$"
	evidence_id:   string & !=""
	owner_project: string & !=""
	reason:        string & !=""
}

#ReleaseNotesInitiativeStatusGate: {
	parent_initiative:      "HoBo v1 Release Readiness"
	launch_risk_change:    "unchanged" | "increased" | "reduced"
	status_update_required: bool
	update_source:          string & !=""
}

#ReleaseNotesPublicClaimGuard: {
	id:          string & !=""
	claim:       string & !=""
	evidence_id: string & !=""
	disposition: "hold" | "draft" | "publish"
}

#ReleaseNotesReleaseCandidateEvidenceRecord: {
	issue:                        "HOBO-473"
	project:                      "V1 Release Notes & Upgrade Guide"
	phase:                        "M3"
	milestone:                    "M3 Release candidate"
	evidence:                     [...#ReleaseNotesReleaseCandidateEvidenceItem]
	blockers:                     [...#ReleaseNotesReleaseCandidateBlocker]
	accepted_risks:               [...#ReleaseNotesReleaseCandidateAcceptedRisk]
	release_cutline_dependencies: [...#ReleaseNotesReleaseCutlineDependency]
	follow_ups:                   [...#ReleaseNotesReleaseCandidateFollowUp]
	initiative_status:            #ReleaseNotesInitiativeStatusGate
	scope_out:                    [...string]
	public_claim_guards:          [...#ReleaseNotesPublicClaimGuard]
}
