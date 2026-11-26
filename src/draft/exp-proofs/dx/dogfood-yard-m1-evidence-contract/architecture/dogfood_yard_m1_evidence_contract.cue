// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#DogfoodGapDecision: "unspecified" | "beta-blocker" | "launch-note" | "follow-up-work"

#DogfoodScenarioEvidence: {
	id:             string & !=""
	owner_project: string & !=""
	evidence:       [...string]
	cutline_impact: string & !=""
}

#DogfoodM1EvidenceRecord: {
	issue:                "HOBO-455"
	project:              "V1 Dogfood Yard & Hosted Operations"
	phase:                "M1"
	required_evidence:    [...string]
	scenario_evidence:    [...#DogfoodScenarioEvidence]
	gap_decisions:        [...#DogfoodGapDecision]
	cutline_dependencies: [...string]
}
