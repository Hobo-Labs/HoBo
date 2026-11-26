package architecture_evidence

#ClosureBuilderLoweringResourceKind: "api" | "cache" | "queue"

#KindScopedGeneratedResourceId: {
	kind: "api"
	generated_id: =~"^res_([0-9]{4}|api_[0-9]{4})$"
} | {
	kind: "cache"
	generated_id: =~"^res_([0-9]{4}|cache_[0-9]{4})$"
} | {
	kind: "queue"
	generated_id: =~"^res_([0-9]{4}|queue_[0-9]{4})$"
}

#GeneratedResourceId: =~"^res_([0-9]{4}|(api|cache|queue)_[0-9]{4})$"

#ClosureBuilderLoweringInput: {
	bindle_name: =~"^[a-z][a-z0-9-]*$"
	resources: [...#ClosureBuilderLoweringResource]
	aliases: [...#ClosureBuilderAlias]
	relationships: [...#ClosureBuilderRelationship]
	requires_same_kind_identity_ledger?: bool
}

#ClosureBuilderLoweringResource: #KindScopedGeneratedResourceId & {
	workload?: #ClosureBuilderWorkloadDescriptor
	annotations?: [...#ProviderAnnotation]
}

#ClosureBuilderWorkloadDescriptor: {
	kind: "inert-workload-factory"
	entrypoint?: string & !=""
}

#ProviderAnnotation: {
	provider: string & !=""
	option: string & !=""
	value_json: string
}

#ClosureBuilderAlias: {
	alias: =~"^[a-z][A-Za-z0-9]*$"
	generated_id: #GeneratedResourceId
}

#ClosureBuilderRelationship: {
	from: #GeneratedResourceId
	to: #GeneratedResourceId
	verb: "dependsOn"
}

#ClosureBuilderManifestSnapshot: {
	schema: "hobo.manifest/v1"
	bindle: =~"^[a-z][a-z0-9-]*$"
	resources: [...#ClosureBuilderManifestResource]
	relationships: [...#ClosureBuilderRelationship]
	authoring_aliases: [...#ClosureBuilderAlias]
}

#ClosureBuilderManifestResource: #KindScopedGeneratedResourceId & {
	manifest_type: "component.v1" | "kv.v1" | "queue.v1"
	port: "wasi:http" | "wasi:keyvalue" | "hobo:queue"
	workload?: #ClosureBuilderWorkloadDescriptor
	links?: [...#ClosureBuilderLinkFacet]
	provider_options?: [...#ProviderAnnotation]
}

#ClosureBuilderLinkFacet: {
	to: #GeneratedResourceId
	relationship: "dependsOn"
}

#ClosureBuilderLoweringEvidenceEvent: {
	event_id: =~"^evt_[a-z0-9]+$"
	event_type: "closureBuilder.ManifestLowered"
	issue_id: "HOBO-535"
	input: #ClosureBuilderLoweringInput
	manifest: #ClosureBuilderManifestSnapshot
}
