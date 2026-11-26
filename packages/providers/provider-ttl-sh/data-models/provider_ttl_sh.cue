// CUE constraints for every protobuf type in provider_ttl_sh.proto, so the
// architecture guard can confirm the boundary shapes are bounded at parse time.
//
// The invariants that matter here are the ones an unauthenticated registry
// makes load-bearing: the host is a constant, the name is unguessable, the TTL
// never exceeds the documented 24-hour ceiling, and the lifecycle fields can
// only spell out "expires, never claimed".

package provider_ttl_sh

import "list"

// A minted UUID. Version nibble 1-8 so any UUID version is accepted, but the
// variant and the lowercase hex are pinned.
#TtlShUuidName: =~"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"

// The content-addressed form: the artifact's own digest, `:` swapped for `-`
// because a tag grammar has no room for a colon.
#TtlShContentAddressedName: =~"^sha256-[0-9a-f]{64}$"

#TtlShArtifactName: #TtlShUuidName | #TtlShContentAddressedName

#TtlShArtifactDigest: =~"^sha256:[0-9a-f]{64}$"

#TtlShInstantIso: =~"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{3})?Z$"

#TtlShNameKind: "TTL_SH_NAME_KIND_UUID" | "TTL_SH_NAME_KIND_CONTENT_ADDRESSED"

#TtlShTtlUnit: "TTL_SH_TTL_UNIT_MINUTES" | "TTL_SH_TTL_UNIT_HOURS"

#TtlShPushState: "TTL_SH_PUSH_STATE_IN_FLIGHT" | "TTL_SH_PUSH_STATE_PUSHED" | "TTL_SH_PUSH_STATE_FAILED"

#TtlShFactKind: "TTL_SH_FACT_KIND_ARTIFACT_PUSHED" | "TTL_SH_FACT_KIND_ARTIFACT_ADOPTED" |
	"TTL_SH_FACT_KIND_LEASE_EXPIRED" | "TTL_SH_FACT_KIND_ARTIFACT_PROMOTED"

// Reproducible kinds, plus the one acknowledged exception. No value here names
// durable state, and that absence is the enforcement: a record that could say
// "database backup" would let a projection describe a durable use of a registry
// that deletes everything within a day.
#TtlShReproducibleKind: "TTL_SH_PAYLOAD_KIND_CI_BUILD_IMAGE" |
	"TTL_SH_PAYLOAD_KIND_INTEGRATION_TEST_FIXTURE" |
	"TTL_SH_PAYLOAD_KIND_CROSS_MACHINE_HANDOFF" |
	"TTL_SH_PAYLOAD_KIND_PACK_CANDIDATE_IMAGE"

#TtlShPayloadKind: #TtlShReproducibleKind | "TTL_SH_PAYLOAD_KIND_ACCEPTED_TEMPORARY_HANDOFF"

// A registry host, and never this one: promoting into another anonymous expiring
// registry changes the expiry date and nothing about who is responsible.
#TtlShOwnerRegistry: =~"^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$" & !="ttl.sh" & !="ttl.sh:443"

#TtlShMediaType: =~"^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$"

#TtlShHandoffAcknowledgement: {
	// Long enough to be an answer rather than a placeholder. "yes" is not an
	// acceptance and "n/a" is not a location.
	accepted_by:           string & !="" & =~"^.{8,512}$"
	reason:                string & =~"^.{8,512}$"
	durable_copy_location: string & =~"^.{8,512}$"
	promotion_target:      #TtlShOwnerRegistry
	promote_within_minutes: uint32 & >=1 & <=1440
}

#TtlShPayloadDescriptor: {
	kind:          #TtlShPayloadKind
	artifact_type: #TtlShMediaType

	// A reproducible payload states how it is regenerated and carries no
	// acknowledgement; an acknowledged handoff is the mirror image. Neither
	// combination is optional, because "reproducible, and nobody wrote down how"
	// is the state that turns a vanished artifact into an incident.
	if kind != "TTL_SH_PAYLOAD_KIND_ACCEPTED_TEMPORARY_HANDOFF" {
		reproduced_by: string & =~"^.{8,512}$"
		acknowledgement?: _|_
	}
	if kind == "TTL_SH_PAYLOAD_KIND_ACCEPTED_TEMPORARY_HANDOFF" {
		acknowledgement: #TtlShHandoffAcknowledgement
	}
}

#TtlShPromotionRecord: {
	source_reference:  =~"^ttl\\.sh/[0-9a-f-]{36,71}@sha256:[0-9a-f]{64}$"
	target_registry:   #TtlShOwnerRegistry
	target_repository: =~"^[a-z0-9]+([._]|__|-+[a-z0-9]+)*(/[a-z0-9]+([._]|__|-+[a-z0-9]+)*)*$"
	target_tag:        =~"^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$"
	digest:            #TtlShArtifactDigest
	promoted_at_ms:    int & >0
	// Strictly positive: a promotion recorded with no lease left is a promotion
	// that raced the reaper, and the copy it claims to have made may not exist.
	source_remaining_ms:        int & >0
	discharged_acknowledgement: bool

	// The source is addressed by digest, so the promoted copy and the recorded
	// digest are the same fact stated twice.
	_pinnedToDigest: true & (source_reference =~ ("@" + digest + "$"))
}

#TtlShTtlWindow: {
	value:   uint32 & >0 & <=1440
	unit:    #TtlShTtlUnit
	minutes: uint32 & >=1 & <=1440
	text:    =~"^[1-9][0-9]{0,3}[mh]$"

	// The normalization is part of the contract: hours are minutes times
	// sixty, and nothing downstream may disagree about which one it read.
	if unit == "TTL_SH_TTL_UNIT_HOURS" {
		_hours: true & (minutes == value*60)
	}
	if unit == "TTL_SH_TTL_UNIT_MINUTES" {
		_minutes: true & (minutes == value)
	}
}

#TtlShImageReference: {
	// One registry, spelled as a constant. A suffix or subdomain match here
	// would admit a lookalike host that this unauthenticated push would
	// happily succeed against.
	host:           "ttl.sh"
	name:           #TtlShArtifactName
	name_kind:      #TtlShNameKind
	ttl:            #TtlShTtlWindow
	pull_reference: =~"^ttl\\.sh/[0-9a-f-]{36,71}:[1-9][0-9]{0,3}[mh]$"

	// The pull reference is derived, never independently supplied.
	_derived: true & (pull_reference == "ttl.sh/" + name + ":" + ttl.text)

	// A UUID name is per-deployment; a content-addressed name is the digest.
	if name_kind == "TTL_SH_NAME_KIND_UUID" {
		name: #TtlShUuidName
	}
	if name_kind == "TTL_SH_NAME_KIND_CONTENT_ADDRESSED" {
		name: #TtlShContentAddressedName
	}
}

#TtlShPushRecord: {
	definition_id: "ttl-sh.ephemeral-oci-artifact/v1"
	provider_id:   "ttl-sh"
	resource_ref:  string & !=""
	reference:     #TtlShImageReference
	digest:        #TtlShArtifactDigest
	size_bytes:    uint64 & >0
	pushed_at_ms:  int & >0
	expires_at_ms: int & >0
	// Never "provider-reported": ttl.sh states no expiry instant, and
	// claiming it did would dress local arithmetic up as a provider fact.
	expiry_source: "computed-from-ttl"
	adopted:       bool
	state:         #TtlShPushState

	// The lease is exactly the requested TTL after the push, and can never
	// outlive the documented ceiling.
	_lease:   true & (expires_at_ms == pushed_at_ms + reference.ttl.minutes*60000)
	_ceiling: true & (expires_at_ms <= pushed_at_ms + 1440*60000)
}

#TtlShProvisionReceipt: {
	schema_version: "hobo.provider-ttl-sh.receipt/v1"
	definition_id:  "ttl-sh.ephemeral-oci-artifact/v1"
	provider_id:    "ttl-sh"
	resource_ref:   string & !=""
	pull_reference: =~"^ttl\\.sh/[0-9a-f-]{36,71}:[1-9][0-9]{0,3}[mh]$"
	registry_host:  "ttl.sh"
	artifact_name:  #TtlShArtifactName
	name_kind:      #TtlShNameKind
	digest:         #TtlShArtifactDigest
	size_bytes:     uint64 & >0
	ttl:            #TtlShTtlWindow
	pushed_at_ms:   int & >0
	expires_at_ms:  int & >0
	expires_at_iso: #TtlShInstantIso
	expiry_source:  "computed-from-ttl"
	adopted:        bool

	// The four fields that keep this from ever reading as hosting.
	bootstrap_class:    "public-anonymous"
	claim_mode:         "none-expire"
	claim_action_count: 0
	cleanup_policy:     "retain-until-provider-expiry"
	teardown:           "expiry-only"
	// Anyone holding the reference can pull it. Stated, never implied.
	visibility: "public-unauthenticated"

	binding_profiles: [...("binding.oci-image-pull/v1")] & list.MinItems(1)
	// Empty by construction: there is nothing to migrate off, because the
	// caller still holds the artifact it pushed.
	migration_profiles: [] | *[]

	_lease: true & (expires_at_ms == pushed_at_ms + ttl.minutes*60000)
}

#TtlShProviderFact: {
	kind:           #TtlShFactKind
	occurred_at_ms: int & >0
	resource_ref:   string & !=""
	pull_reference: =~"^ttl\\.sh/[0-9a-f-]{36,71}:[1-9][0-9]{0,3}[mh]$"
	digest:         #TtlShArtifactDigest
	detail: [string]: string
}
