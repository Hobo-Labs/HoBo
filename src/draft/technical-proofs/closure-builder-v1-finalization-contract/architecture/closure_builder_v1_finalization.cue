package closure_builder_v1_finalization

#ClosureBuilderV1FinalizationRecord: {
	parent_issue: "HOBO-531"
	authoring_package: "@hobo/bindles"
	authoring_model: "closure-builder"
	contract_ref: "urn:hobo:requirement:closure-builder-public-api"
	evidence: [...#ClosureBuilderEvidenceEntry]
}

#ClosureBuilderEvidenceEntry: {
	issue_id: =~"^HOBO-(532|533|534|535|536|537|538)$"
	linear_status: "Done"
	proof_path: =~"^src/draft/.+"
	evidence_ref: =~"^urn:hobo:(requirement|proof):.+"
	accepted_scope: =~"^[^\\n]{8,}$"
}

#ClosureBuilderFinalizationEvent: {
	event_id: =~"^evt_[a-z0-9]+$"
	event_type: "closureBuilder.V1FinalizationAccepted"
	parent_issue: "HOBO-531"
	record: #ClosureBuilderV1FinalizationRecord
}
