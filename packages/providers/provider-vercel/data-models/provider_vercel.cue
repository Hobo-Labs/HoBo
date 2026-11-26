// Invariants for every protobuf type in provider_vercel.proto.
//
// These are the rules that keep a sponsor-backed transfer honest: a sponsored
// offer may never describe itself as anonymous, a stored locator may never be
// a URL carrying a code, the transfer deadline is the provider's documented 24
// hour window rather than a locally invented TTL, and an item that completes
// carries evidence.

package provider_vercel

// HoBo's own path-safety constraint on a provider identifier, matching what the
// driver is willing to place in a request path. Vercel documents no public id
// format, so this deliberately does not pretend to pin one.
#PathSafeId: =~"^[A-Za-z0-9._~-]{1,128}$"

// A custody locator, never material. The trailing check is the one that
// matters: a claim URL carrying `?code=…` is a credential, not a reference.
#SecretRefLocator: =~"^hobo-(?:secret|token)://[A-Za-z0-9._~/-]+$" & !~"[?#]"

#EpochMillis: int & >0

#IsoDate: =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"

// The only REST origin the guarded transport will dial (VERCEL_API_ALLOWED_HOSTS).
#VercelApiHost: "api.vercel.com"

// The dashboard host that serves the human ceremony. This package never calls it.
#VercelClaimHost: "vercel.com"

// Documented on the create-project-transfer-request reference (checked 2026-08-08).
#TransferCodeTtlMs: 86400000

#SponsoredClaimSubjectKind: "SPONSORED_CLAIM_SUBJECT_KIND_PROJECT" |
	"SPONSORED_CLAIM_SUBJECT_KIND_ASSOCIATED_RESOURCE"

#SponsoredClaimObservedStatus: "SPONSORED_CLAIM_OBSERVED_STATUS_PENDING" |
	"SPONSORED_CLAIM_OBSERVED_STATUS_CLAIMED" |
	"SPONSORED_CLAIM_OBSERVED_STATUS_EXPIRED"

#VerifiedSourceRef: {
	url:        =~"^https://"
	checked_on: #IsoDate
	note:       string & !=""
}

#SponsorIsolationRecord: {
	boundary:         "dedicated-sponsor-team-and-project"
	credential_scope: "single-project-deploy-and-transfer"
	// Pooling one sponsor credential across tenants is the provider-terms
	// violation this field exists to make unrepresentable.
	shared_with_other_tenants: false
}

#SponsoredTransferBootstrapRecord: {
	definition_id:   "vercel.sponsored-project-transfer/v1"
	bootstrap_class: "sponsor"
	// There is an account and a payer before the claim; this is the field that
	// keeps the sponsored path from being sold as an anonymous one.
	publicly_anonymous:       false
	sponsor_backed:           true
	initial_owner:            "hobo-sponsor"
	cost_bearer_before_claim: "hobo-sponsor"
	cost_bearer_after_claim:  "claiming-team"
	// Zero exposure would advertise the offer as user-funded or anonymous.
	sponsor_exposure_minor_units: int & >0
	isolation:                    #SponsorIsolationRecord
	offer_summary:                string & !=""
	// One human action: accepting the project transfer request.
	human_claim_actions: 1
	sources: [#VerifiedSourceRef, ...#VerifiedSourceRef]
}

#ProjectTransferCodeRecord: {
	project_id:          #PathSafeId
	code_secret_ref:     #SecretRefLocator
	one_time_action_ref?: string & !=""
	issued_at_ms:        #EpochMillis
	expires_at_ms:       #EpochMillis
	ttl_ms:              #TransferCodeTtlMs
	claim_host:          #VercelClaimHost
	// The deadline is the provider's window applied to the issue instant, not a
	// locally chosen duration.
	_deadlineIsDocumentedWindow: true & (expires_at_ms == issued_at_ms + ttl_ms)
}

#VercelProjectView: {
	id:   #PathSafeId
	name: string & !=""
	// Read from GET /v9/projects/{idOrName} over #VercelApiHost. Absent, there
	// is no ownership fact to compare and verification must fail closed.
	account_id: string & !=""
}

#SponsoredClaimItemRecord: {
	id:                   string & !=""
	subject_ref:          string & !=""
	subject_kind:         #SponsoredClaimSubjectKind
	provider_id:          "vercel"
	claim_strategy_ref:   =~"^vercel\\.sponsored-project-transfer/v1#"
	mode:                 "project-transfer" | "resource-claim"
	one_time_action_ref?: string & !=""
	deadline_at_ms:       #EpochMillis
	verification_ref:     string & !=""
	// Every item owes sponsor-authority revocation; only the database is
	// rebound, so only the resource item may owe a rotation.
	post_claim_actions: [...("rotate-binding" | "revoke-bootstrap-authority")]
	if mode == "project-transfer" {
		post_claim_actions: ["revoke-bootstrap-authority"]
	}
	creator_authority_after_claim: "absent" | "rotatable" | "retained" | "unknown"
	status:                        "pending" | "in-progress" | "observed" | "verified" | "completed" | "expired" | "failed"
}

#SubjectClaimOutcomeRecord: {
	item_id:  string & !=""
	observed: #SponsoredClaimObservedStatus
	verified: bool
	evidence_ref: string & !=""
	rotated_binding_id?:      string & !=""
	revocation_evidence_ref?: string & !=""
	// Verification is only meaningful once the provider reported the claim.
	_verifiedImpliesClaimed: true & (!verified |
		observed == "SPONSORED_CLAIM_OBSERVED_STATUS_CLAIMED")
}

#SponsoredClaimReport: {
	bundle_id:     string & !=""
	bundle_status: "pending" | "in-progress" | "partially-claimed" | "claimed-needs-remediation" | "complete" | "expired" | "failed"
	lifecycle:     string & !=""
	atomic_success: bool
	outstanding_item_ids: [...string & !=""]
	failure_code?: string & !=""
	// Atomic success is the reducer's ruling, and it cannot coexist with an
	// outstanding item. A half-moved bundle is repairable, never a success.
	_successHasNothingOutstanding: true & (!atomic_success | len(outstanding_item_ids) == 0)
}

#SponsorAuthorityRevocationRecord: {
	evidence_ref: string & !=""
	// An empty set means the caller never recorded the pre-claim tokens, which
	// is indistinguishable from having revoked nothing.
	revoked_token_ids: [string & !="", ...string & !=""]
	sponsor_principal_removed: true
}

#RotatedAssociatedResourceBindingRecord: {
	binding_id:            string & !=""
	resource_ref:          string & !=""
	capability_profile_ref: "data.postgres/v1"
	binding_profile_ref:    "binding.postgresql/v1"
	credential_secret_ref:  #SecretRefLocator
	host:                   =~"^[A-Za-z0-9.-]+$"
	port?:                  int & >0 & <=65535
	producer_evidence_ref:  string & !=""
	rotated_at_ms:          #EpochMillis
}

#VercelDropClassificationRecord: {
	definition_id:               "vercel.drop-station/v1"
	separate_from_definition_id: "vercel.sponsored-project-transfer/v1"
	bootstrap_class:             "anonymous-claimable"
	// Retaining a Drop project requires a Vercel account, which is exactly why
	// it is not a direct anonymous deployment.
	account_required_to_retain:  true
	direct_anonymous_deployment: false
	rationale:                   string & !=""
	sources: [#VerifiedSourceRef, ...#VerifiedSourceRef]
}
