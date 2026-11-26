// Guest lease and claim invariants.
//
// These encode the rules that make a claim honest: a bundle spanning providers
// cannot call itself atomic, a renewal count cannot exceed its cap, and a claim
// item that leaves creator authority in place must say so rather than reporting
// clean ownership.

#Instant: =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T"

#GuestLeaseStatus: "provisioning" | "active" | "claiming" | "claimed-needs-reauthorization" |
	"owner-controlled" | "owner-and-agent-controlled" | "expired" | "compensating" |
	"destroyed" | "failed"

#CleanupPolicy: "delete" | "retain-until-provider-expiry" | "transfer" | "migrate"

#GuestLeaseRecord: {
	schema_version:             "hobo.guest-lease/v1"
	id:                         string & !=""
	subject_ref:                string & !=""
	bootstrap_strategy_ref:     string & !=""
	created_at:                 #Instant
	expires_at?:                #Instant
	claim_by?:                  #Instant
	renewable:                  bool
	maximum_renewals?:          uint
	renewal_count:              uint
	quota_ref?:                 string
	cost_cap_ref?:              string
	cleanup_policy:             #CleanupPolicy
	status:                     #GuestLeaseStatus
	observed_provider_version?: string
	fencing_token:              string & !=""
	// A non-renewable lease that has already been renewed is a bug in the
	// writer, not a state worth persisting.
	_renewalsBounded: true & (renewable | renewal_count == 0)
}

#SubjectKind: "yard" | "camp" | "resource" | "connector" | "bindle" | "agent-principal"

#OwnershipMode: "account-claim" | "organization-claim" | "workspace-claim" | "project-transfer" |
	"site-claim" | "resource-claim" | "credential-exchange" |
	"explicit-user-reauthorization" | "migration" | "none"

#ClaimContinuityRecord: {
	endpoint:    "preserved" | "rebound" | "changed" | "not-applicable"
	data:        "preserved" | "migrated" | "discarded" | "not-applicable"
	credentials: "revoked" | "rotated" | "reauthorized" | "retained" | "unknown" | "not-applicable"
}

#PostClaimActionRecord: {
	id:          string & !=""
	kind:        "rotate-binding" | "revoke-bootstrap-authority" | "reauthorize-agent" | "redeploy" | "verify-health"
	blocking:    bool
	description: string
}

#ClaimItemRecord: {
	id:                            string & !=""
	subject_ref:                   string & !=""
	subject_kind:                  #SubjectKind
	provider_id:                   string & !=""
	claim_strategy_ref:            string & !=""
	mode:                          #OwnershipMode
	one_time_action_ref?:          string
	deadline?:                     #Instant
	continuity:                    #ClaimContinuityRecord
	creator_authority_after_claim: "absent" | "reauthorization-required" | "rotatable" | "retained" | "unknown"
	verification_ref:              string & !=""
	post_claim_actions:            [...#PostClaimActionRecord]
	status:                        "pending" | "in-progress" | "observed" | "verified" | "needs-rotation" | "completed" | "expired" | "failed"
	evidence_ref?:                 string
	// Completion requires evidence. A provider redirect is not ownership.
	_completedHasEvidence: true & (status != "completed" | evidence_ref != _|_)
}

#ClaimDependencyRecord: {
	from_item_id: string & !=""
	to_item_id:   string & !=""
	reason:       string & !=""
	// A claim item cannot depend on itself; the coordinator orders items by
	// this graph and a self-edge would deadlock the bundle.
	_noSelfEdge: true & (from_item_id != to_item_id)
}

#ClaimCompensationRecord: {
	on_timeout:       "destroy" | "retain-until-provider-expiry"
	on_partial_claim: "rollback-when-supported" | "continue-and-repair" | "migrate"
	rollback_window?: =~"^P"
}

#ClaimBundleRecord: {
	schema_version:    "hobo.claim-bundle/v1"
	id:                string & !=""
	deployment_ref:    string & !=""
	items:             [...#ClaimItemRecord]
	dependency_edges:  [...#ClaimDependencyRecord]
	atomicity:         "single-resource" | "provider-bundled" | "best-effort-saga"
	earliest_deadline?: #Instant
	compensation:      #ClaimCompensationRecord
	status: "pending" | "in-progress" | "partially-claimed" | "claimed-needs-remediation" |
		"complete" | "expired" | "compensating" | "failed"
	// One item is the only case that can be a single-resource claim.
	_singleResourceIsSingle: true & (atomicity != "single-resource" | len(items) == 1)
}
