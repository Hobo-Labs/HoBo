package sdk_object_graph_manifest_ir_shapes

#ProofMode: "live" | "simulated" | "reference-fixture" | "scope-out" | "type-test"

#TypeSurface: {
	import_from:        "@hobo/bindles"
	generated_bindings: [...=~"^hobo:sdk/"]
	manifest_version:   "hobo.manifest/v1"
	lowers_to:          "hobo:sdk WIT bindings"
	compile_proof:      "type-test"
}

#CompileConsumer: {
	import_from:        "@hobo/bindles"
	generated_bindings: [_, _, ...=~"^hobo:sdk/"]
	manifest_version:   "hobo.manifest/v1"
	resource_refs:      [_, _, ...string]
	typed_client_calls: [_, _, _, ...string]
	debt_markers:       ["raw-provider-edge", "authoritative-external-resource", ...string]
}

#Audience: {
	actor:            =~"^(app developer|platform engineer|agent/MCP caller)$"
	goal:             string & != ""
	friction:         string & != ""
	success_criteria: string & != ""
}

#ExampleConsumer: {
	kind:              "desired-resource-graph" | "provider-capability-reference" | "deployment-plan-request" | "migration-plan-request" | "inspect-log-subscription-reader"
	proof_mode:        #ProofMode
	fixture_id:        =~"^sdk-object-graph\\."
	fixture_input:     =~"^fixtures/input/.+"
	fixture_output:    =~"^fixtures/output/.+"
	sdk_snippet:       string & != ""
	manifest_ir_shape: string & != ""
	expected_artifact: =~"^[a-z-]+/[a-z0-9-]+\\.json$"
	type_surface:      #TypeSurface
}

#DebtMarker: {
	kind:           "raw-provider-edge" | "authoritative-external-resource"
	surfaced_by:    [_, _, ...string]
	author_message: string & != ""
}

#ScopeBoundary: {
	in_scope:      [_, _, _, ...string]
	out_of_scope: [_, _, _, _, ...string]
}

#SdkObjectGraphProof: {
	issue:          "HOBO-568"
	parent_issue:   "HOBO-566"
	phase:          "M1"
	target_package: "src/draft/exp-proofs/api/sdk-object-graph-manifest-ir-shapes"
	proof_note:     "docs/design/proofs/sdk-object-graph-manifest-ir-shapes/README.md"
	design_anchors: [...string]
	audience:       [#Audience, #Audience, #Audience, ...#Audience]
	proof_mode_labels: [...#ProofMode]
	type_surface:         #TypeSurface
	example_consumers:    [#ExampleConsumer, #ExampleConsumer, #ExampleConsumer, #ExampleConsumer, #ExampleConsumer, ...#ExampleConsumer]
	debt_markers:         [#DebtMarker, #DebtMarker, ...#DebtMarker]
	scope_boundary:       #ScopeBoundary
	compile_expectations: [_, _, _, ...string]
	compile_consumers:    [#CompileConsumer, ...#CompileConsumer]
}
