// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#ComplianceEvidencePackScopeReadiness: "unspecified" | "accepted" | "manual" | "limited" | "blocked" | "blocked-until-evidence"

#ComplianceEvidencePackScopeSection: {
	id:                       string & !=""
	owner_project:            string & !=""
	source_record:            string & =~"^docs/design/.+\\.md$"
	beta_readiness:           #ComplianceEvidencePackScopeReadiness
	ga_readiness:             #ComplianceEvidencePackScopeReadiness
	blocker_route:            string & !=""
	customer_safe_limitation: string & !=""
}

#ComplianceEvidencePackScopeBoundary: {
	id:    "service" | "ux" | "security" | "support" | "legal-privacy" | "release"
	owner: string & !=""
	rule:  string & !=""
}

#ComplianceEvidencePackScopeRecord: {
	issue:              "HOBO-452"
	goal:               string & !=""
	primary_personas:   [...string]
	assurance_sections: [...#ComplianceEvidencePackScopeSection]
	m1_evidence:        [...string]
	scope_out:          [...string]
	non_goals:          [...string]
	boundaries:         [...#ComplianceEvidencePackScopeBoundary]
}
