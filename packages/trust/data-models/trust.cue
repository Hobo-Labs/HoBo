// Trust evidence and verdict invariants.
//
// These encode the rules that make the gate fail closed: evidence that expires
// before it was tested is not evidence, an unknown check is not a pass, a
// verdict that records a reason is not selectable, and an override that waives
// nothing is not an override.

package data_models

import (
	"strings"
	"struct"
)

#Digest: =~"^sha256:[0-9a-f]{64}$"

#ProviderId: =~"^[a-z0-9]+(-[a-z0-9]+)*$"

// ISO date a human checked a third-party source, optionally with a time.
#CheckedAt: =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9:.]+Z)?$"

#EvidenceCheckOutcome: "pass" | "fail" | "unknown"

#EvidenceVerificationOutcome: "valid" | "invalid" | "unknown"

#EvidenceFreshnessState: "fresh" | "absent" | "future-dated" | "aged" | "expired"

#CreatorAuthorityRequirement: "must-be-absent" | "must-be-rotatable" | "may-be-retained"

#CreatorAuthorityAfterClaim: "absent" | "reauthorization-required" | "rotatable" | "retained" | "unknown"

#ProviderClass: "established" | "verified-emerging" | "experimental"

#RealizationKind: "native" | "pack" | "bridge"

#EvidenceSourceRef: {
	// Provider terms are ranking input, never billing input: a source is only
	// citable over https and only with the date a human read it.
	url:        =~"^https://"
	checked_at: #CheckedAt
	note?:      string
}

#DeclaredRealizations: {
	kinds: [...#RealizationKind]
}

#TrustEvidence: {
	schema_version:        "hobo.trust-evidence/v1"
	provider_id:           #ProviderId
	product_definition_id: string & !=""
	adapter_version:       string & !=""
	provider_class:        #ProviderClass
	tested_at:             int
	expires_at:            int
	// At least one check, because evidence recording nothing tested is not
	// evidence, and an absent check key is never read as a pass.
	checks: {[string & !=""]: #EvidenceCheckOutcome} & struct.MinFields(1)
	creator_authority_after_claim: #CreatorAuthorityAfterClaim
	claim_action_count:            int & >=0 & <=32
	realizations?:                 #DeclaredRealizations
	sponsor_backed?:               bool
	evidence_digest:               #Digest
	signature:                     string & !=""
	// A claim about the world cites where it came from.
	source_refs: [...#EvidenceSourceRef] & [_, ...]
	// Evidence that expires before it was taken describes no window at all.
	_expiryAfterTest: true & (expires_at > tested_at)
}

#TrustRequirement: {
	minimum_provider_class:              #ProviderClass
	require_official_bootstrap_contract: bool
	require_documented_claim_contract:   bool
	creator_authority_after_claim:       #CreatorAuthorityRequirement
	maximum_claim_actions:               int & >=0 & <=32
	maximum_evidence_age_ms:             int & >0
	require_standard_binding:            bool
	require_export_profile:              bool
	allow_sponsor:                       bool
	allow_pack:                          bool
	allow_bridge:                        bool
	required_checks: [...string & !=""]
}

#TrustReason: {
	code:   string & !=""
	detail: string & !=""
}

#TrustVerdict: {
	schema_version:        "hobo.trust-verdict/v1"
	selectable:            bool
	provider_id:           string
	product_definition_id: string
	adapter_version:       string
	evaluated_at_ms:       int
	verifier_id:           string & !=""
	signature_outcome:     #EvidenceVerificationOutcome
	evidence_digest?:      #Digest
	evidence_age_ms?:      int
	expires_at_ms?:        int
	reasons: [...#TrustReason]
	verdict_digest: #Digest
	// Selectable means every gate passed. A verdict carrying a reason is not
	// selectable, and an unverified signature is a reason.
	_selectableIsClean: true & (!selectable | len(reasons) == 0)
	_selectableIsSigned: true & (!selectable | signature_outcome == "valid")
}

#EvidenceFreshness: {
	state:           #EvidenceFreshnessState
	fresh:           bool
	detail:          string & !=""
	age_ms?:         int
	expires_at_ms?:  int
	remaining_ms?:   int & >=0
	// `fresh` is a projection of the state, not a second opinion about it.
	_freshIsState: true & (fresh == (state == "fresh"))
	// Only an absent record has nothing to say about its own age.
	_datedUnlessAbsent: true & (state == "absent" | age_ms != _|_)
}

#TrustBundleSubjectVerdict: {
	subject_id: string & !=""
	verdict:    #TrustVerdict
	freshness:  #EvidenceFreshness
}

#TrustBundleReason: {
	subject_id: string & !=""
	code:       string & !=""
	detail:     string & !=""
}

#TrustBundleVerdict: {
	schema_version:  "hobo.trust-bundle-verdict/v1"
	selectable:      bool
	evaluated_at_ms: int
	verifier_id:     string & !=""
	subjects: [...#TrustBundleSubjectVerdict]
	reasons: [...#TrustBundleReason]
	bundle_digest: #Digest
	// One bad product sinks the bundle, and an empty bundle vouches for
	// nothing rather than vacuously passing.
	_selectableIsUnanimous: true & (!selectable | len(subjects) > 0)
	_selectableIsClean:     true & (!selectable | len(reasons) == 0)
}

#OperatorOverrideRecord: {
	schema_version: "hobo.trust-override/v1"
	operator_id:    string & !=""
	// Enough characters to be an actual justification rather than "ok".
	reason:        string & strings.MinRunes(12)
	granted_at_ms: int
	expires_at_ms: int
	// Blanket overrides are not expressible: the codes are enumerated.
	waived_codes: [...string & !=""] & [_, ...]
	ticket_ref?: string & !=""
	active:      bool
	unwaived_codes: [...string & !=""]
	record_digest: #Digest
	_expiryAfterGrant: true & (expires_at_ms > granted_at_ms)
	// An override may not outlive the operator's memory of granting it: 90d.
	_boundedWindow: true & (expires_at_ms-granted_at_ms <= 7776000000)
}

#OverriddenTrustVerdict: {
	verdict: #TrustVerdict & {selectable: false}
	// Manual authorization requires an active override that covers every
	// recorded reason code; it never makes the verdict automatically
	// selectable.
	manually_authorized: bool
	override:            #OperatorOverrideRecord
	_authorizedIsActive: true & (!manually_authorized | override.active)
	_authorizedCoversAll: true & (!manually_authorized | len(override.unwaived_codes) == 0)
}
