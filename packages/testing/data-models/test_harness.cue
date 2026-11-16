// App test harness invariants.
//
// Two constraints here are load-bearing rather than decorative. First, a
// handle carries an endpoint only when something actually listens, so an
// endpoint on a `mocked` or `camp-only` handle is a contradiction and is
// rejected — an unreachable URL presented as an endpoint is the quiet lie the
// fidelity labels exist to prevent. Second, `prod_readiness_claimable` is
// derived, not asserted: it is false whenever any assertion rested on a
// `mocked` handle (ADR-0042 / ADR-0159), so a report cannot be hand-written
// into a green tick.

#FidelityLabel: "real" | "simulated" | "mocked" | "camp-only"

#LaneKind: "in-process" | "ephemeral-camp"

#Alias: =~"^[^\\s]+$"

#Endpoint: =~"^https?://[^\\s]+$"

#ResourceHandleRecord: {
	alias:     #Alias
	kind:      string & !=""
	fidelity:  #FidelityLabel
	endpoint?: #Endpoint
	// Only a served handle may advertise an endpoint.
	_endpointImpliesExecution: true & (endpoint == _|_ | fidelity == "simulated" | fidelity == "real")
}

#FidelityAssertionRecord: {
	alias:    #Alias
	fidelity: #FidelityLabel
}

#FidelityReportRecord: {
	by_fidelity: {
		real:        uint
		simulated:   uint
		mocked:      uint
		"camp-only": uint
	}
	asserted_against: [...#FidelityAssertionRecord]
	prod_readiness_claimable: bool
	// Derived, never asserted: a mocked handle under any assertion forfeits
	// the claim, so the flag cannot be hand-written into a green tick.
	_mockedAssertions: [for entry in asserted_against if entry.fidelity == "mocked" {entry}]
	_claimIsDerived: true & (prod_readiness_claimable == (len(_mockedAssertions) == 0))
}

#DeployedGraphRecord: {
	contract: "hobo.test-harness/v1"
	stage:    =~"^[a-z][a-z0-9-]*$"
	lane:     #LaneKind
	handles: [...#ResourceHandleRecord]
	fidelity: #FidelityReportRecord
	teardown_order: [...#Alias]
	// Teardown covers exactly the deployed handles.
	_teardownIsTotal: true & (len(teardown_order) == len(handles))
}

#HarnessRefusalCode: "HARNESS_ALIAS_UNKNOWN" | "HARNESS_BINDLE_INVALID" |
	"HARNESS_CREDENTIAL_NOT_A_REF" | "HARNESS_CREDENTIALS_REQUIRED" |
	"HARNESS_CYCLIC_DEPENDENCY" | "HARNESS_ENDPOINT_UNAVAILABLE" |
	"HARNESS_LANE_INVALID" | "HARNESS_LANE_UNIMPLEMENTED" |
	"HARNESS_READINESS_EXHAUSTED" | "HARNESS_READINESS_OPTIONS_INVALID" |
	"HARNESS_READINESS_REJECTED" | "HARNESS_RUNNER_INVALID" |
	"HARNESS_RUNNER_UNDETECTED" | "HARNESS_STAGE_INVALID" |
	"HARNESS_YARD_INVALID" | "HARNESS_YARD_REQUIRED"

#HarnessRefusalRecord: {
	code:    #HarnessRefusalCode
	message: string & !=""
	// A refusal that does not say what to change is a dead end.
	remediation: string & !=""
	// Locators only: a refusal never carries a credential value.
	_noCredentialValue: true & (remediation !~ "(?i)(password|api[_-]?key|secret=)")
}
