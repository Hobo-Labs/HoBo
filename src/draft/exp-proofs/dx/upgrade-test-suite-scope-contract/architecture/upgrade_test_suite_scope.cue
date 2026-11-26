// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#UpgradeTestSuiteEvidenceKind: "unspecified" | "design-record" | "reference-fixture" | "contract-test" | "recovery-fixture" | "schema" | "support-handoff"

#UpgradeTestSuiteScopeRecord: {
	issue:             "HOBO-433"
	project:           "Upgrade Test Suite"
	phase:             "M0"
	goal:              string & !=""
	boundaries:        [...#UpgradeTestSuiteBoundary]
	required_evidence: [...#UpgradeTestSuiteEvidence]
}

#UpgradeTestSuiteBoundary: {
	id:      "service" | "ux" | "security" | "support"
	owner:   string & !=""
	promise: string & !=""
}

#UpgradeTestSuiteEvidence: {
	id:    string & !=""
	owner: string & !=""
	proof: string & !=""
}
