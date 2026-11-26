// Selection-candidate invariants: the cross-field rules the protobuf shape
// cannot express, plus the canonical-form rules a digest depends on.
//
// Three of these are load-bearing rather than decorative.
//
//   1. Set-valued fields are sorted by code point and free of duplicates.
//      A digest taken over a candidate is only comparable across packages if
//      two catalogs that hold the same facts encode them the same way, and
//      code-point order is the only order that does not depend on the host's
//      collation locale (the rule `@hobo/bindings` already applies to Yard
//      binding row keys).
//   2. `implements_profiles` is deliberately NOT sorted here. Selection takes
//      the FIRST entry that satisfies a required profile, so the order is a
//      fact about the candidate, not a presentation detail. Duplicate
//      profile_ids are refused instead: a product claiming the same profile
//      twice makes the choice between the two claims depend on list position
//      with nothing to appeal to.
//   3. `evidence_expires_at_ms` is optional and never null. Absent means "no
//      trust evidence recorded", which fails the evidence gate closed. Zero is
//      a real (long-expired) instant and means something different.
//
// `implements_profiles` may be empty. That is not an oversight: a
// connectivity-only product such as Cloudflare Hyperdrive produces a binding
// profile and satisfies no `data.*` requirement whatsoever
// (CLOUDFLARE_TEMPORARY_HYPERDRIVE in @hobo/provider-cloudflare), so requiring
// at least one claim here would refuse a real, deliberate catalog row.

import "list"

#SelectionCandidateSchemaVersion: "hobo.selection-candidate/v1"

// Same syntax @hobo/capability-profiles pins for a profile id.
#ProfileId: =~"^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*/v[0-9]+$"

#VersionRange: =~"^(\\*|[><]=?|=|\\^|~)?\\s*v?[0-9]+(\\.[0-9]+){0,2}$"

#BindleRuntime: "wasm" | "oci" | "vm_iaas" | "paas" | "serverless_faas"

#RealizationKind: "native" | "pack" | "bridge"

#ConformanceResult: "pass" | "fail" | "unknown"

#ProviderClass: "established" | "verified-emerging" | "experimental"

#CreatorAuthorityAfterClaim: "absent" | "reauthorization-required" | "rotatable" | "retained" | "unknown"

#ContinuityGrade: "preserved" | "rebound" | "migrated" | "changed" | "discarded" | "not-applicable"

#CredentialContinuity: "revoked" | "rotated" | "reauthorized" | "retained" | "unknown" | "not-applicable"

#ClaimAtomicity: "single-resource" | "provider-bundled" | "best-effort-saga"

// A capability value is a scalar or a list of strings.
//
// This is the narrowing of `google.protobuf.Value` — the protobuf spelling of
// the same field — that the .proto cannot state. Nested objects and null are
// refused: a structured capability is compared with equals / at-least /
// at-most / one-of / includes-all, and none of those operators has a defined
// meaning over an object, so admitting one would only produce a gate that is
// never satisfied and never explains itself.
#StructuredCapabilityValue: bool | number | string | [...string]

#ProfileImplementationRecord: {
	profile_id:      #ProfileId
	version_range:   #VersionRange
	realization:     #RealizationKind
	conformance_ref: string & !=""
	conformance:     #ConformanceResult
}

#CandidateContinuityRecord: {
	endpoint:    #ContinuityGrade
	data:        #ContinuityGrade
	credentials: #CredentialContinuity
}

#SelectionCandidateRecord: {
	schema_version: #SelectionCandidateSchemaVersion
	definition_id:  string & !=""
	provider_id:    string & !=""

	// Ordered, and never two claims for the same profile.
	implements_profiles: [...#ProfileImplementationRecord]
	_uniqueProfileClaims: true & list.UniqueItems([for claim in implements_profiles {claim.profile_id}])

	runtime_models: [...#BindleRuntime]
	_canonicalRuntimeModels: true & list.IsSorted(runtime_models, list.Ascending) & list.UniqueItems(runtime_models)

	structured_capabilities: [string]: #StructuredCapabilityValue

	produces_binding_profiles: [...string & !=""]
	_canonicalBindingProfiles: true & list.IsSorted(produces_binding_profiles, list.Ascending) & list.UniqueItems(produces_binding_profiles)

	migration_profiles: [...string & !=""]
	_canonicalMigrationProfiles: true & list.IsSorted(migration_profiles, list.Ascending) & list.UniqueItems(migration_profiles)

	provider_class: #ProviderClass

	// Optional, never null: absence is the "no live evidence" fact.
	evidence_expires_at_ms?:       int
	evidence_signature_valid:      bool
	creator_authority_after_claim: #CreatorAuthorityAfterClaim
	claim_atomicity:               #ClaimAtomicity
	claim_action_count:            uint
	continuity:                    #CandidateContinuityRecord
	supports_export:               bool
	supports_rotation:             bool
	supports_revocation:           bool
	sponsor_exposure_minor_units:  uint
	has_registered_driver:         bool
	secret_custody_available:      bool
}
