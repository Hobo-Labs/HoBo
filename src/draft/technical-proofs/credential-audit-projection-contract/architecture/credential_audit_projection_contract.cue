// CUE constraints for every protobuf type in this package's schema.

package architecture_evidence

#CredentialAuditProjectionContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#CredentialAuditProjectionContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

#CredentialAuditTimelineEntry: {
	seq:       int & >=0
	time:      string & !=""
	type:      string & !=""
	event_id:  string & !=""
	grant_id:  string
	usage_id:  string
}

#CredentialAuditViewSnapshot: {
	view:   string & !=""
	seq:    int & >=0
	digest: string & =~"^[0-9a-f]{64}$"
	timeline_entries: [...#CredentialAuditTimelineEntry]
}
