package closure_builder_tooling_contract

#ClosureBuilderToolingManifest: {
	schema: "hobo.manifest/v1"
	bindle_name: =~"^[a-z][a-z0-9-]*$"
	resources: [...#ClosureBuilderToolingResource]
	relationships: [...#ClosureBuilderToolingRelationship]
}

#ClosureBuilderToolingResource: {
	alias: =~"^[A-Za-z_$][A-Za-z0-9_$]*$"
	generated_id: =~"^res_[0-9]{4}$"
	kind: "api" | "cache" | "queue"
	file_name: =~".+\\.ts$"
	line: >0
}

#ClosureBuilderToolingRelationship: {
	from: =~"^res_[0-9]{4}$"
	to: =~"^res_[0-9]{4}$"
	verb: "dependsOn"
}

#ClosureBuilderToolingCoverage: {
	status: "pass" | "fail"
	observed_resource_ids: [...=~"^res_[0-9]{4}$"]
	diagnostics: [...#ClosureBuilderToolingDiagnostic]
}

#ClosureBuilderToolingDiagnostic: {
	code: "closureBuilder.coverage.unobserved-resource"
	severity: "error"
	alias: =~"^[A-Za-z_$][A-Za-z0-9_$]*$"
	generated_id: =~"^res_[0-9]{4}$"
	file_name: =~".+\\.ts$"
	line: >0
	message: =~".+"
}

#ClosureBuilderGeneratedAlias: {
	alias: =~"^[A-Za-z_$][A-Za-z0-9_$]*$"
	generated_id: =~"^res_[0-9]{4}$"
	kind: "api" | "cache" | "queue"
}

#ClosureBuilderToolingEvidenceEvent: {
	event_id: =~"^evt_[a-z0-9]+$"
	event_type: "closureBuilder.ToolingEvaluated"
	issue_id: "HOBO-536"
	manifest: #ClosureBuilderToolingManifest
	coverage: #ClosureBuilderToolingCoverage
	generated_aliases: [...#ClosureBuilderGeneratedAlias]
}
