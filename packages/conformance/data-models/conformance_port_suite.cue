package conformance

#FailureCode:
	"adapter.missing-function" |
	"adapter.threw" |
	"adapter.output-mismatch" |
	"golden-ir.mismatch" |
	"golden-ir.language-leak" |
	"trace-replay.regression" |
	"determinism.second-run-failed" |
	"determinism.seed-drift" |
	"coverage.claimed-unexercised" |
	"semantics-annex.missing-vector"

#AssertionCode:
	"adapter.output" |
	"golden-ir.equivalence" |
	"trace-replay.equivalence"

#ConformanceTier: "local" | "camp"

#ClaimStatus: "listed" | "blocked"

PortSuite: {
	schema: "hobo.conformance.port-suite/v1"
	id:     string & !=""
	port:   PortRef
	coverage: CoverageRequirements
	cases:  [...SuiteCase] & [_, ...]
}

PortRef: {
	wit:       string & !=""
	functions: [...string & !=""] & [_, ...]
}

CoverageRequirements: {
	required_functions: [...string & !=""]
}

SuiteCase: {
	id:        string & !=""
	tier:      #ConformanceTier
	exercises: [...string & !=""]
	call:      SuiteCall
	expect?:   SuiteExpect
}

SuiteCall: {
	function: string & !=""
}

SuiteExpect: close({
	output_json?:       _
	golden_ir_json?:    _
	replay_trace_json?: _
})

PortSuiteReport: {
	schema:     "hobo.conformance.port-suite-report/v1"
	ok:         bool
	suite_id:   string & !=""
	port:       string & !=""
	adapter_id: string & !=""
	seed:       string & !=""
	provenance: RunProvenance
	claim:      AdapterClaim
	assertions: [...CaseAssertion]
	coverage:   CoverageManifest
	failures:   [...ConformanceFailure]
}

RunProvenance: {
	suite_id:   string & !=""
	port:       string & !=""
	adapter_id: string & !=""
	seed:       string & !=""
	cases:      [...string & !=""]
}

AdapterClaim: {
	status:        #ClaimStatus
	port:          string & !=""
	adapter_id:    string & !=""
	failure_codes: [...#FailureCode]
}

CaseAssertion: {
	code:     #AssertionCode
	case_id:  string & !=""
	function: string & !=""
}

ValueDiff: {
	path:          string & !=""
	expected_json: string
	actual_json:   string
}

ConformanceFailure: {
	code: #FailureCode
}

CoverageManifest: {
	exercised_functions:   [...string]
	required_functions:    [...string]
	unexercised_functions: [...string]
}

SdkParityReport: {
	schema:   "hobo.conformance.sdk-parity-report/v1"
	ok:       bool
	language: string & !=""
	failures: [...ConformanceFailure]
}

ConformanceRunEvent: {
	type: string & !=""
}
