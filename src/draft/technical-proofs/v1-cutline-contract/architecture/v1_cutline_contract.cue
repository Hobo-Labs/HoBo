// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#V1CutlineContractEvidenceKind: "unspecified" | "design-record" | "contract-test" | "m1-dogfood-alpha" | "m2-private-beta" | "m3-release-candidate" | "m4-ga-handoff"

#V1CutlineContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

#V1CutlineDogfoodAlphaEvidence: {
	issue:                      "HOBO-454"
	phase:                      "M1"
	milestone_gate:             "M1 Dogfood/alpha proof"
	required_evidence_ids:      [...string]
	blockers:                   [...string]
	accepted_risks:             [...string]
	cross_project_dependencies: [...string]
	missing_evidence:           [...string]
	follow_up_issues:           [...string]
	parent_status_updated:      bool
}

#V1CutlinePrivateBetaEvidence: {
	issue:                      "HOBO-461"
	phase:                      "M2"
	milestone_gate:             "M2 Private beta proof"
	required_evidence_ids:      [...string]
	blockers:                   [...string]
	accepted_risks:             [...string]
	cross_project_dependencies: [...string]
	missing_evidence:           [...string]
	follow_up_issues:           [...string]
	parent_status_updated:      bool
}

#V1CutlineReleaseCandidateEvidence: {
	issue:                      "HOBO-468"
	phase:                      "M3"
	milestone_gate:             "M3 Release candidate"
	required_evidence_ids:      [...string]
	blockers:                   [...string]
	accepted_risks:             [...string]
	cross_project_dependencies: [...string]
	missing_evidence:           [...string]
	follow_up_issues:           [...string]
	parent_status_updated:      bool
	scope_out:                  [...string]
	public_claim_guards:        [...string]
}

#V1CutlineGaHandoffEvidence: {
	issue:                      "HOBO-475"
	phase:                      "M4"
	milestone_gate:             "M4 GA handoff"
	required_evidence_ids:      [...string]
	blockers:                   [...string]
	accepted_risks:             [...string]
	cross_project_dependencies: [...string]
	missing_evidence:           [...string]
	follow_up_issues:           [...string]
	parent_status_updated:      bool
	scope_out:                  [...string]
	public_claim_guards:        [...string]
}
