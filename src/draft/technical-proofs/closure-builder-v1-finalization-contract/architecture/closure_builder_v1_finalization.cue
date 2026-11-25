package closure_builder_v1_finalization

#ClosureBuilderV1FinalizationRecord: {
	parent_issue: "HOBO-531"
	authoring_package: "@hobo/bindles"
	authoring_model: "closure-builder"
	canonical_doc_path: "docs/design/closure-builder-public-api.md"
	evidence: [...#ClosureBuilderEvidenceEntry]
}

#ClosureBuilderEvidenceEntry: {
	issue_id: =~"^HOBO-(532|533|534|535|536|537|538)$"
	linear_status: "Done"
	proof_path: =~"^src/draft/.+"
	design_path: =~"^docs/design/.+"
	accepted_scope: =~"^[^\\n]{8,}$"
}

#ClosureBuilderFinalizationEvent: {
	event_id: =~"^evt_[a-z0-9]+$"
	event_type: "closureBuilder.V1FinalizationAccepted"
	parent_issue: "HOBO-531"
	record: #ClosureBuilderV1FinalizationRecord
}
