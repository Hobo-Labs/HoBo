// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#LegalPrivacyGaEvidenceStatus: "unspecified" | "accepted" | "accepted-risk" | "missing"

#LegalPrivacyGaBlockerState: "unspecified" | "cleared" | "accepted-risk"

#LegalPrivacyGaEvidenceItem: {
	id:                string & !=""
	owner_project:     string & !=""
	source:            string & !=""
	proof_mode:        "design-record" | "issue-state" | "manual-review" | "release-cutline"
	status:            #LegalPrivacyGaEvidenceStatus
	acceptance_bullet: string & !=""
}

#LegalPrivacyGaBlocker: {
	id:                 string & !=""
	owner_project:      string & !=""
	state:              #LegalPrivacyGaBlockerState
	source_evidence_id: string & !=""
	disposition:        string & !=""
}

#LegalPrivacyGaAcceptedRisk: {
	id:                 string & !=""
	owner_project:      string & !=""
	mitigation:         string & !=""
	launch_risk_effect: "unchanged" | "reduced"
}

#LegalPrivacyGaReleaseCutlineDependency: {
	id:               string & !=""
	owner_project:    string & !=""
	readiness_domain: "legal" | "privacy" | "customer-assurance" | "security" | "release-cutline"
	cutline_category: string & =~"^v1-blocker\\."
	source:           string & !=""
}

#LegalPrivacyGaMissingEvidence: {
	id:            string & !=""
	owner_project: string & !=""
	reason:        string & !=""
}

#LegalPrivacyGaFollowUp: {
	id:            string & =~"^HOBO-[0-9]+$"
	evidence_id:   string & !=""
	owner_project: string & !=""
	reason:        string & !=""
}

#LegalPrivacyGaInitiativeStatusGate: {
	parent_initiative:      "HoBo v1 Release Readiness"
	launch_risk_change:    "unchanged" | "reduced"
	status_update_required: bool
	update_source:          string & !=""
}

#LegalPrivacyGaPublicClaimGuard: {
	id:          string & !=""
	claim:       string & !=""
	evidence_id: string & !=""
	disposition: "hold" | "draft" | "publish"
}

#LegalPrivacyGaHandoffEvidenceRecord: {
	issue:                        "HOBO-478"
	project:                      "V1 Legal, Privacy & Terms Readiness"
	phase:                        "M4"
	milestone:                    "M4 GA handoff"
	evidence:                     [...#LegalPrivacyGaEvidenceItem]
	blockers:                     [...#LegalPrivacyGaBlocker]
	accepted_risks:               [...#LegalPrivacyGaAcceptedRisk]
	release_cutline_dependencies: [...#LegalPrivacyGaReleaseCutlineDependency]
	missing_evidence:             [...#LegalPrivacyGaMissingEvidence]
	follow_ups:                   [...#LegalPrivacyGaFollowUp]
	initiative_status:            #LegalPrivacyGaInitiativeStatusGate
	scope_out:                    [...string]
	public_claim_guards:          [...#LegalPrivacyGaPublicClaimGuard]
}
