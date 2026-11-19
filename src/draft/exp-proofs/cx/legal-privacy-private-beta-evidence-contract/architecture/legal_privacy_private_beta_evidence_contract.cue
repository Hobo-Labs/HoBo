
package architecture_evidence

#PrivateBetaEvidenceStatus: "unspecified" | "accepted" | "pending" | "missing"

#LegalPrivacyPrivateBetaEvidence: {
	issue:                      "HOBO-464"
	parent_issue:               "HOBO-405"
	phase:                      "M2"
	milestone_gate:             "M2 Private beta proof"
	required_evidence_ids:      [...string]
	blockers:                   [...string]
	accepted_risks:             [...string]
	cross_project_dependencies: [...string]
	missing_evidence:           [...string]
	follow_up_issues:           [...string]
	unsupported_public_claims:  [...string]
	parent_status_updated:      bool
}
