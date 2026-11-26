package architecture_evidence

#ClosureBuilderAuthorFlowResourceKind: "api" | "cache" | "queue"

#KindScopedAuthorFlowResourceId: {
	kind: "api"
	generated_id: =~"^res_api_[0-9]{4}$"
} | {
	kind: "cache"
	generated_id: =~"^res_cache_[0-9]{4}$"
} | {
	kind: "queue"
	generated_id: =~"^res_queue_[0-9]{4}$"
}

#AuthorFlowGeneratedResourceId: =~"^res_(api|cache|queue)_[0-9]{4}$"

#ClosureBuilderAuthorFlowCorpus: {
	name: =~"^[a-z][a-z0-9-]+$"
	bindle_name: =~"^[a-z][a-z0-9-]*$"
	resources: [...#ClosureBuilderAuthorFlowResource]
	aliases: [...#ClosureBuilderAuthorFlowAlias]
	relationships: [...#ClosureBuilderAuthorFlowRelationship]
	manifest: #ClosureBuilderAuthorFlowManifest
	conformance_corpus_path: =~"^src/draft/technical-proofs/closure-builder-author-flow-contract/src/.+#.+$"
}

#ClosureBuilderAuthorFlowResource: #KindScopedAuthorFlowResourceId & {
	owner_bindle_id: =~"^[a-z][a-z0-9-]*$"
	has_inert_workload: bool
}

#ClosureBuilderAuthorFlowAlias: #KindScopedAuthorFlowResourceId & {
	alias: =~"^[a-z][A-Za-z0-9]*$"
	physical_name_seed: =~"^[a-z][a-z0-9-]*:res_(api|cache|queue)_[0-9]{4}$"
}

#ClosureBuilderAuthorFlowRelationship: {
	from: #AuthorFlowGeneratedResourceId
	to: #AuthorFlowGeneratedResourceId
	verb: "dependsOn"
}

#ClosureBuilderAuthorFlowManifest: {
	schema: "hobo.manifest/v1"
	bindle: =~"^[a-z][a-z0-9-]*$"
	resources: [...#ClosureBuilderAuthorFlowResource]
	relationships: [...#ClosureBuilderAuthorFlowRelationship]
	authoring_aliases: [...#ClosureBuilderAuthorFlowAlias]
}

#ClosureBuilderAuthorFlowCorpusPublished: {
	event_id: =~"^evt_[a-z0-9]+$"
	event_type: "closureBuilder.AuthorFlowCorpusPublished"
	issue_id: "HOBO-537"
	corpus: #ClosureBuilderAuthorFlowCorpus
}
