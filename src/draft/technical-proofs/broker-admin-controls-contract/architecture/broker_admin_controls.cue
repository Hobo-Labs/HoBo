package broker_admin_controls

#NonEmptyString: string & =~"\\S"

#AdminActor: {
	id:   #NonEmptyString
	role: "broker-admin" | "security-reviewer" | "support-operator" | "platform-engineer"
}

#BrokerEnvironmentProposal: {
	id:                 #NonEmptyString
	environment_id:     #NonEmptyString
	proposed_by:        #NonEmptyString
	requested_changes:  [...#NonEmptyString]
	audit_evidence_ids: [#NonEmptyString, ...#NonEmptyString]
	state:              "pending"
}

#BrokerEnvironmentSnapshot: {
	id:                 #NonEmptyString
	version:            int & >=1
	source_proposal_id: #NonEmptyString
	approved_by:        #NonEmptyString
	audit_evidence_ids: [#NonEmptyString, ...#NonEmptyString]
	state:              "approved" | "revoked"
}

#ResolutionReceiptRef: {
	receipt_id:          #NonEmptyString
	environment_id:      #NonEmptyString
	environment_version: int & >=1
	digest:              =~"^sha256:[a-zA-Z0-9]+"
	immutable:           true
}

#BrokerAdminAction: {
	kind:                  #NonEmptyString
	actor_id:              #NonEmptyString
	target_environment_id: #NonEmptyString
	proposal_id?:          #NonEmptyString
	receipt_id?:           #NonEmptyString
	audit_evidence_id?:    string
	requested_changes?:    [...#NonEmptyString]
	reviewer_evidence_ids?: [...#NonEmptyString]
}

#BrokerAdminEvent: {
	type: "BrokerEnvironmentProposalRecorded" | "BrokerEnvironmentSnapshotApproved" | "BrokerEnvironmentSnapshotRevoked"
	actor_id:              #NonEmptyString
	target_environment_id: #NonEmptyString
	audit_evidence_ids:    [#NonEmptyString, ...#NonEmptyString]
}

#BrokerAdminState: {
	pending_proposals:    [...#BrokerEnvironmentProposal]
	environment_snapshots: [...#BrokerEnvironmentSnapshot]
	issued_receipt_refs: [...#ResolutionReceiptRef]
}
