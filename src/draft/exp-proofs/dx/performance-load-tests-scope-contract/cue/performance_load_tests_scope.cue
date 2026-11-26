// CUE constraints for every protobuf type in
// proto/performance_load_tests_scope.proto. These bound the HOBO-440
// Performance & Load Tests M0 scope record so downstream M1+ tooling can
// reject malformed scope evidence at parse time.

package performance_load_tests_v1

#ProofMode:
	"design-record" |
	"contract-test" |
	"reference-fixture" |
	"release-handoff" |
	"support-handoff" |
	"security-review"

#Persona: {
	role: string & !=""
	need: string & !=""
}

#DesignDependency: {
	source: string & !=""
	reason: string & !=""
}

#InitiativeDependency: {
	owner:         string & !=""
	consumes:      string & !=""
	scopeBoundary: string & !=""
}

#M1Evidence: {
	kind:      string & !=""
	owner:     string & !=""
	proofMode: #ProofMode
	source:    string & !=""
	proves:    string & !=""
}

#FollowUpGate: {
	allowedAfter:  string & !=""
	blockedBefore: string & !=""
}

#PerformanceLoadTestsScope: {
	issue:                  "HOBO-440"
	project:                "Performance & Load Tests"
	phase:                  "M0"
	goal:                   string & !=""
	personas:               [...#Persona] & [_, _, _, _, _, ...]
	scopeIn:                [...string] & [_, _, _, _, _, ...]
	scopeOut:               [...string] & [_, _, _, _, _, ...]
	nonGoals:               [...string] & [_, _, _, ...]
	dependencies:           [...#DesignDependency]
	initiativeDependencies: [...#InitiativeDependency]
	scenarioDimensions:     [...string]
	m1Evidence:             [...#M1Evidence]
	followUpGate:           #FollowUpGate
}
