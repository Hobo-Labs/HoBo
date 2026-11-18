#FidelityLabel: "real" | "simulated" | "mocked" | "camp-only"

#LaneKind: "in-process" | "ephemeral-camp"

#Alias: =~"^[^\\s]+$"

#Endpoint: =~"^https?://[^\\s]+$"

#ResourceHandleRecord: {
	alias:     #Alias
	kind:      string & !=""
	fidelity:  #FidelityLabel
	endpoint?: #Endpoint
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
	_teardownIsTotal: true & (len(teardown_order) == len(handles))
}

#HarnessRefusalCode: "HARNESS_ALIAS_UNKNOWN" | "HARNESS_BINDLE_INVALID" |
	"HARNESS_CAMP_DEPLOYMENT_INVALID" | "HARNESS_CAMP_DRIVER_REQUIRED" |
	"HARNESS_CREDENTIAL_NOT_A_REF" | "HARNESS_CREDENTIALS_REQUIRED" |
	"HARNESS_CYCLIC_DEPENDENCY" | "HARNESS_ENDPOINT_UNAVAILABLE" |
	"HARNESS_LANE_INVALID" |
	"HARNESS_READINESS_EXHAUSTED" | "HARNESS_READINESS_OPTIONS_INVALID" |
	"HARNESS_READINESS_REJECTED" | "HARNESS_RUNNER_INVALID" |
	"HARNESS_RUNNER_UNDETECTED" | "HARNESS_STAGE_INVALID" |
	"HARNESS_YARD_INVALID" | "HARNESS_YARD_REQUIRED"

#HarnessRefusalRecord: {
	code:    #HarnessRefusalCode
	message: string & !=""
	remediation: string & !=""
	_noCredentialValue: true & (remediation !~ "(?i)(password|api[_-]?key|secret=)")
}
