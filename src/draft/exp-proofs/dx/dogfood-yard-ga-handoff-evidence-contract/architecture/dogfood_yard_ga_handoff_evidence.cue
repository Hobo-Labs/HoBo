// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#DogfoodYardGaEvidenceStatus: "unspecified" | "accepted" | "accepted-risk" | "in-review" | "missing"

#DogfoodYardGaBlockerState: "unspecified" | "blocked" | "accepted-risk" | "cleared"

#DogfoodYardGaEvidenceItem: {
	id:                string & !=""
	owner_project:     string & !=""
	source:            string & !=""
	proof_mode:        "design-record" | "issue-state" | "manual-review" | "release-cutline"
	status:            #DogfoodYardGaEvidenceStatus
	acceptance_bullet: string & !=""
}

#DogfoodYardGaBlocker: {
	id:                 string & !=""
	owner_project:      string & !=""
	state:              #DogfoodYardGaBlockerState
	source_evidence_id: string & !=""
	disposition:        string & !=""
}

#DogfoodYardGaAcceptedRisk: {
	id:                 string & !=""
	owner_project:      string & !=""
	mitigation:         string & !=""
	launch_risk_effect: "unchanged" | "reduced" | "increased"
}

#DogfoodYardGaReleaseCutlineDependency: {
	id:               string & !=""
	owner_project:    string & !=""
	readiness_domain: "operations-readiness" | "release-cutline" | "support" | "documentation" | "reliability" | "bootstrap" | "broker"
	cutline_category: string & =~"^v1-blocker\\."
	source:           string & !=""
}

#DogfoodYardGaMissingEvidence: {
	id:            string & !=""
	owner_project: string & !=""
	reason:        string & !=""
}

#DogfoodYardGaFollowUp: {
	id:            string & =~"^HOBO-[0-9]+$"
	evidence_id:   string & !=""
	owner_project: string & !=""
	reason:        string & !=""
}

#DogfoodYardGaInitiativeStatusGate: {
	parent_initiative:      "HoBo v1 Release Readiness"
	launch_risk_change:    "unchanged" | "reduced" | "increased"
	status_update_required: bool
	update_source:          string & !=""
}

#DogfoodYardGaPublicClaimGuard: {
	id:          string & !=""
	claim:       string & !=""
	evidence_id: string & !=""
	disposition: "hold" | "draft" | "publish"
}

#DogfoodYardGaHandoffEvidenceRecord: {
	issue:                        "HOBO-476"
	project:                      "V1 Dogfood Yard & Hosted Operations"
	phase:                        "M4"
	milestone:                    "M4 GA handoff"
	scope_in:                     [...string]
	scope_out:                    [...string]
	evidence:                     [...#DogfoodYardGaEvidenceItem]
	blockers:                     [...#DogfoodYardGaBlocker]
	accepted_risks:               [...#DogfoodYardGaAcceptedRisk]
	release_cutline_dependencies: [...#DogfoodYardGaReleaseCutlineDependency]
	missing_evidence:             [...#DogfoodYardGaMissingEvidence]
	follow_ups:                   [...#DogfoodYardGaFollowUp]
	initiative_status:            #DogfoodYardGaInitiativeStatusGate
	public_claim_guards:          [...#DogfoodYardGaPublicClaimGuard]
}
