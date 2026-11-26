// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#V1ReadinessDashboardEmptyStateColor: "unspecified" | "green" | "yellow" | "red" | "gray"

#V1ReadinessDashboardField: {
	name:              "cutline" | "blockers" | "milestoneHealth" | "evidenceLinks" | "acceptedRisks" | "owners" | "lastVerifiedAt"
	label:             string & !=""
	source_of_truth:   string & !=""
	update_cadence:    string & !=""
	owner_project:    string & !=""
	empty_state_label: string & !=""
	empty_state_color: #V1ReadinessDashboardEmptyStateColor
	launch_meaning:    string & !=""
}

#V1ReadinessDashboardContractRecord: {
	issue:     "HOBO-482"
	schema:    string & !=""
	fields:    [...#V1ReadinessDashboardField]
	scope_out: [...string]
}
