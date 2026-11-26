// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the supervision data shapes are bounded at
// parse time.

package supervision_child_lifetime_contract

#SupervisionChildLifetimeEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SupervisionFact: {
	type:      string & !=""
	at_ms:     uint64
	parent_id?: string & !=""
	child_id?:  string & !=""
	reason?:    string & !=""
}

#SupervisionFixture: {
	name:       string & !=""
	assertions: [...string] & [_, ...]
	facts:      [...#SupervisionFact] & [_, ...]
}

#SupervisionCaseResult: {
	name:              string & !=""
	status:            "passed" | "failed"
	code?:             string & !=""
	proven_acceptance: [...string]
}

#SupervisionReport: {
	suite:        string & !=""
	spec_version: string & !=""
	status:       "passed" | "failed"
	cases:        [...#SupervisionCaseResult] & [_, ...]
}
