package broker_receipt_integrity

#ResolutionReceipt: {
	payload:             #ReceiptPayload
	digest:              =~"^sha256:[a-f0-9]{64}$"
	signature:           =~"^[A-Za-z0-9+/=]+$"
	signature_algorithm: "Ed25519"
	key_id:              =~"^broker-[a-z0-9-]+$"
}

#ReceiptPayload: {
	receipt_id:             =~"^receipt-[a-z0-9-]+$"
	issuer:                 "meta-cloud-broker"
	schema_version:         uint & >=2
	tenant_id:              =~"^tenant-[a-z0-9-]+$"
	environment_id:         =~"^[a-z0-9-]+$"
	manifest_digest:        =~"^sha256:.+"
	broker_snapshot_digest: =~"^sha256:.+"
	issued_at:              string
	expires_at:             string
	gatekeeper_boundary:    "policy-after-receipt"
	resource_bindings: [...#ReceiptResourceBinding] & [_, ...]
}

#ReceiptResourceBinding: {
	resource_id:                 =~"^[a-z][a-z0-9-]*$"
	provider_capability_digest: =~"^sha256:.+"
	mapping_digest:             =~"^sha256:.+"
}

#ReceiptExpectation: {
	tenant_id:              =~"^tenant-[a-z0-9-]+$"
	environment_id:         =~"^[a-z0-9-]+$"
	manifest_digest:        =~"^sha256:.+"
	broker_snapshot_digest: =~"^sha256:.+"
	min_schema_version:     uint & >=2
}

#SupportSafeReceiptEvidence: {
	receipt_id:             string
	tenant_id:              string
	environment_id:         string
	manifest_digest:        string
	broker_snapshot_digest: string
	support_safe:           true
}

#ReceiptAccepted: {
	receipt_id:          string
	authority:           "meta-cloud-broker"
	gatekeeper_boundary: "policy-after-receipt"
	debug_evidence:      #SupportSafeReceiptEvidence
}

#ReceiptRejected: {
	code:           #ReceiptRejectionCode
	message:        string
	debug_evidence: #SupportSafeReceiptEvidence
}

#ReceiptRejectionCode:
	"receipt-integrity-failed" |
	"receipt-expired" |
	"receipt-downgrade-refused" |
	"receipt-tenant-mismatch" |
	"receipt-environment-mismatch" |
	"receipt-snapshot-mismatch" |
	"receipt-manifest-mismatch" |
	"receipt-replay-refused" |
	"receipt-gatekeeper-boundary-invalid"
