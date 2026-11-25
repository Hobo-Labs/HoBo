package issue_worker_guardrail_mapping

#IssueWorkerGuardrailMappingRecord: {
	parent_issue: "HOBO-702"
	automation_doc_path: "docs/automations/hobo-issue-worker.md"
	rows: [...#GuardrailMappingRow] & [_, _, _, _, _, _]
	authoritative_refs: [...string] & [_, _, _, _, _]
}

#GuardrailMappingRow: {
	platform_guardrail: =~"^[^\\n]{8,}$"
	issue_worker_enforcement: =~"^[^\\n]{8,}$"
}

#IssueWorkerGuardrailMappingEvent: {
	event_id: =~"^evt_[a-z0-9]+$"
	event_type: "automation.GuardrailMappingAccepted"
	parent_issue: "HOBO-702"
	record: #IssueWorkerGuardrailMappingRecord
}
