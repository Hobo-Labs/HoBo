package sdk_conformance

#SemanticsAnnexVector: {
	name:         string & !=""
	category:     #AnnexCategory
	spec_version: #SpecVersion
}

#LoweringFixture: {
	name: string & !=""
}

#VectorCaseResult: {
	name:     string & !=""
	category: string
	status:   #LaneStatus
	if status == "failed" {
		reason:        string & !=""
		expected_json: string & !=""
		actual_json:   string & !=""
		diff_paths:    [...string] & [_, ...]
	}
}

#LaneReport: {
	lane:   string & !=""
	status: #LaneStatus
	cases:  [...#VectorCaseResult]
}

#SdkConformanceReport: {
	suite:        "@hobo/conformance/sdk"
	contract:     "hobo:sdk@0.1.0"
	layer_name:   string & !=""
	authorship:   "hand-authored" | "generated"
	status:       #LaneStatus
	corpus_claim: string & =~"bounded by the checked corpus"
	lanes: [
		#LaneReport & {lane: "golden-ir-lowering-equivalence"},
		#LaneReport & {lane: "semantics-annex"},
		...#LaneReport,
	]
}

#AnnexCategory: "error-mapping" | "cancellation" | "async-ordering" | "ifc-side-effects"
#LaneStatus: "passed" | "failed"
#SpecVersion: "hobo.sdk.semantics-annex/v1"
