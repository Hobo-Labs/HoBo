package conformance

SdkWitError: {
	tag:          string & !=""
	message?:     string
	deadline_ms?: number & >=0
	retry?:       string
}
SdkWitResult: {
	ok?:  _
	err?: SdkWitError
}
SdkCancellationSignal: {
	reason:       string
	deadline_ms?: number & >=0
}
SdkCollectionFact: {
	sequence:  int & >=0
	kind:      "resource" | "handler"
	name?:     string
	resource?: string
	event?:    string
}
SdkExpectedThrow: {name: string, tag: string}
SemanticsAnnexVector: {
	name:            string & !=""
	category:        "error-mapping" | "cancellation" | "async-ordering" | "ifc-side-effects"
	spec_version:    "hobo.sdk.semantics-annex/v1"
	result?:         SdkWitResult
	expected_throw?: SdkExpectedThrow
	signal?:         SdkCancellationSignal
	expected?:       SdkWitResult
	facts?: [...SdkCollectionFact]
	expected_error?: string
}
SdkWitCall: {interface: string, function: string, args: {[string]: _}}
SdkResource: {kind: string, name: string, allow?: _}
SdkHandler: {resource: string, event: string, export_name: string}
SdkManifestIr: {
	schema: "hobo.manifest/v1"
	bindle: string & !=""
	resources: [...SdkResource]
	handlers?: [...SdkHandler]
}
SdkLowerProgram: {
	bindle: string & !=""
	resources: [...SdkResource]
	handlers?: [...SdkHandler]
}
LoweringFixture: {
	name:    string & !=""
	program: SdkLowerProgram
	expected_wit_calls: [...SdkWitCall]
	expected_manifest: SdkManifestIr
}
VectorCaseResult: {
	name:           string & !=""
	category?:      string
	status:         "passed" | "failed"
	reason?:        string
	expected_json?: string
	actual_json?:   string
	diff_paths?: [...string]
	if status == "failed" {
		reason:        string & !=""
		expected_json: string & !=""
		actual_json:   string & !=""
		diff_paths: [...string] & [_, ...]
	}
}
LaneReport: {
	lane:               string & !=""
	status:             "passed" | "failed"
	bounded_by_corpus?: bool
	cases: [...VectorCaseResult]
}
SdkConformanceReport: {
	suite:        "@hobo/conformance/sdk"
	contract:     "hobo:sdk@0.1.0"
	layer_name:   string & !=""
	authorship:   "hand-authored" | "generated"
	status:       "passed" | "failed"
	corpus_claim: string & =~"bounded by the checked corpus"
	lanes: [...LaneReport] & [_, _, _, _, _, ...]
}
SdkResilienceVector: {
	name:     string & !=""
	input:    _
	expected: _
}
