package auditexplorerscope

#AuditExplorerScopeEvidenceKind: =~"^AUDIT_EXPLORER_SCOPE_EVIDENCE_KIND_"

#AuditExplorerAuditFactClass: {
	id:                 string & !=""
	owner:              string & !=""
	event_families:      [...string]
	customer_visible:   bool
	redaction_required: true
}

#AuditExplorerExportEvidence: {
	id:       string & !=""
	owner:    string & !=""
	redacted: true
	includes: [...string]
}

#AuditExplorerScopeRecord: {
	issue:             "HOBO-427"
	project:           "Audit Explorer"
	phase:             "M0"
	personas:          [...string]
	scope_in:          [...string]
	scope_out:         [...string]
	audit_fact_classes: [...#AuditExplorerAuditFactClass]
	query_filter_axes: ["tenant", "project", ...string]
	export_evidence:   [...#AuditExplorerExportEvidence]
}
