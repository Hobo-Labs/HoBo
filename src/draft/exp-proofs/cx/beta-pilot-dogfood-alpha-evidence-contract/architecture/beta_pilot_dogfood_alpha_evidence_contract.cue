// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#BetaPilotDogfoodAlphaEvidenceKind: "unspecified" | "phase-evidence" | "blocker-risk" | "follow-up-policy" | "initiative-status"

#BetaPilotDogfoodAlphaEvidenceItem: {
	id:                string & !=""
	owner_project:     string & !=""
	status:            "accepted" | "missing" | "blocked"
	accepted_evidence: [...string]
}

#BetaPilotDogfoodAlphaBlockerRisk: {
	id:            string & !=""
	route:         "cutline" | "support" | "product-ux" | "docs" | "capability-project"
	owner_project: string & !=""
	status:        "accepted-limitation" | "open-blocker" | "resolved"
	launch_risk:   "none" | "low" | "high"
}

#BetaPilotDogfoodAlphaEvidenceRecord: {
	issue:                                     "HOBO-456"
	phase:                                     "M1"
	source_contract_issue:                     "HOBO-404"
	required_intake_fields:                    [...string]
	required_evidence:                         [...#BetaPilotDogfoodAlphaEvidenceItem]
	blocker_risks:                             [...#BetaPilotDogfoodAlphaBlockerRisk]
	launch_risk_delta:                         "none" | "increased" | "decreased"
	parent_initiative_status_update_required:  bool
}
