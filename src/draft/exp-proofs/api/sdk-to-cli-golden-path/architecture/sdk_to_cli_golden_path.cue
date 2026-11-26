// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#SdkToCliProofMode: "unspecified" | "reference-fixture" | "simulated" | "design-record"

#SdkToCliResultKind: "success" | "gatekeeper-denied" | "contract-incompatible" | "stale-or-unknown-evidence" | "support-handoff"

#SdkToCliCompileCheck: {
	command:  "tsc --noEmit src/consumer.ts"
	expected: string & !=""
}

#SdkToCliConsumer: {
	fixture_id:                    "dx.lifecycle.shop-api.v1"
	file:                          "src/consumer.ts"
	imports:                       [...string] & ["@hobo/bindles", "@hobo/sdk/results"]
	contains_cloud_provider_logic: false
	compile_check:                 #SdkToCliCompileCheck
}

#SdkToCliManifestResource: {
	kind:        "api" | "data"
	name:        string & !=""
	consumes?:   [...string]
	engine?:     "postgres"
	requirement?: "managed"
}

#SdkToCliManifestIr: {
	fixture_id: "dx.lifecycle.shop-api.v1"
	name:       "shop-api"
	resources:  [...#SdkToCliManifestResource]
	proof_mode: #SdkToCliProofMode
}

#SdkToCliTranscriptStep: {
	fixture_id:  "dx.lifecycle.shop-api.v1"
	command:     "hobo collect" | "hobo plan" | "hobo up" | "hobo inspect deploy" | "hobo doctor"
	result_kind: #SdkToCliResultKind
	proof_mode:  #SdkToCliProofMode
	exit_code:   int & >=0
	stdout:      string & !=""
}

#SdkToCliApiOperation: {
	fixture_id: "dx.lifecycle.shop-api.v1"
	route:      string & !=""
	response:   "SdkToCliCommandResult"
}

#SdkToCliMcpToolResult: {
	fixture_id:  "dx.lifecycle.shop-api.v1"
	name:        string & !=""
	result_kind: #SdkToCliResultKind
}

#SdkToCliHandoff: {
	owner:               string & !=""
	consumes_fixture_id: "dx.lifecycle.shop-api.v1"
}

#SdkToCliContractArtifacts: {
	protobuf: "architecture/sdk_to_cli_golden_path.proto"
	cue:      "architecture/sdk_to_cli_golden_path.cue"
	pact:     "architecture/pacts/sdk_to_cli_golden_path.pact.json"
}

#ScopeClaim: string & !~"(?i)(publish @hobo/bindles|package publication|real deploy URL|live MCP|dashboard screenshot|production app scaffold|customer data|credential|live provider)"

#SdkToCliGoldenPathRecord: {
	issue:                 "HOBO-576"
	phase:                 "M1"
	fixture_id:            "dx.lifecycle.shop-api.v1"
	proof_note:            "docs/design/proofs/sdk-to-cli-golden-path/README.md"
	sdk_consumer:          #SdkToCliConsumer
	manifest_ir:           #SdkToCliManifestIr
	cli_transcript:        [...#SdkToCliTranscriptStep]
	api_shape:             [...#SdkToCliApiOperation]
	mcp_result:            [...#SdkToCliMcpToolResult]
	handoffs:              [...#SdkToCliHandoff]
	expected_result_kinds: [...#SdkToCliResultKind]
	contract_artifacts:    #SdkToCliContractArtifacts
	scope_claims:          [...#ScopeClaim]
}
