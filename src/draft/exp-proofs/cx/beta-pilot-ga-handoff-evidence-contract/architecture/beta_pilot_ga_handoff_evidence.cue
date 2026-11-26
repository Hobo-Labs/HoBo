// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#BetaPilotGaEvidenceStatus: "unspecified" | "accepted" | "accepted-risk" | "missing"

#BetaPilotGaProofMode: "unspecified" | "design-record" | "issue-state" | "manual-review" | "release-cutline"

#BetaPilotGaLaunchRiskEffect: "unspecified" | "unchanged" | "increased" | "reduced"

#BetaPilotGaEvidenceItem: {
	id:                string & !=""
	owner_project:     string & !=""
	source:            string & !=""
	proof_mode:        #BetaPilotGaProofMode
	status:            #BetaPilotGaEvidenceStatus
	acceptance_bullet: string & !=""
}

#BetaPilotGaBlocker: {
	id:                 string & !=""
	owner_project:      string & !=""
	state:              "blocked" | "accepted-risk" | "cleared"
	source_evidence_id: string & !=""
	disposition:        string & !=""
}

#BetaPilotGaAcceptedRisk: {
	id:                 string & !=""
	owner_project:      string & !=""
	mitigation:         string & !=""
	launch_risk_effect: #BetaPilotGaLaunchRiskEffect
}

#BetaPilotGaCutlineDependency: {
	id:               string & !=""
	owner_project:    string & !=""
	readiness_domain: "documentation" | "productization" | "operations-readiness" | "support" | "release-cutline"
	cutline_category: =~"^v1-blocker\\."
	source:           string & !=""
}

#BetaPilotGaFollowUp: {
	id:            string & !=""
	evidence_id:   string & !=""
	owner_project: string & !=""
	reason:        string & !=""
}

#BetaPilotGaInitiativeStatusGate: {
	parent_initiative:      "HoBo v1 Release Readiness"
	launch_risk_change:    #BetaPilotGaLaunchRiskEffect
	status_update_required: bool
	update_source:          string
}

#BetaPilotGaPublicClaimGuard: {
	id:          string & !=""
	claim:       string & !=""
	evidence_id: string & !=""
	disposition: "hold" | "draft" | "publish"
}

#BetaPilotGaHandoffEvidenceRecord: {
	issue:                        "HOBO-477"
	project:                      "V1 Beta Pilot & Feedback Loop"
	phase:                        "M4"
	milestone:                    "M4 GA handoff"
	evidence:                     [...#BetaPilotGaEvidenceItem]
	blockers:                     [...#BetaPilotGaBlocker]
	accepted_risks:               [...#BetaPilotGaAcceptedRisk]
	release_cutline_dependencies: [...#BetaPilotGaCutlineDependency]
	follow_ups:                   [...#BetaPilotGaFollowUp]
	initiative_status:            #BetaPilotGaInitiativeStatusGate
	scope_out:                    [...string]
	public_claim_guards:          [...#BetaPilotGaPublicClaimGuard]
}
