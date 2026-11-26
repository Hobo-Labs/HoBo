package closure_builder_public_api

#ClosureBuilderContract: {
	package_name: "@hobo/bindles"
	bindle_signature: "bindle(name, builderFn)"
	bindle_role: "manifest-assembly"
	app_host_owner: "imported-app-code"
	runtime_host_behavior: "out-of-scope"
	relationship_verbs: ["dependsOn"]
	builder_factories: [...#BuilderFactory]
}

#BuilderFactory: {
	name: =~"^[a-z][A-Za-z0-9]*$"
	accepts_resource_name: false
	identity_source: "hobo-generated"
	alias_role: "local-and-returned-key-only"
}

#ClosureBuilderEvidenceEvent: {
	event_id: =~"^evt_[a-z0-9]+$"
	event_type: "closureBuilder.PublicApiPinned"
	issue_id: "HOBO-532"
	contract: #ClosureBuilderContract
}
