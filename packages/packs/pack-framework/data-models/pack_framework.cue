// Invariants that make a pack manifest trustworthy.
//
// The protobuf shapes say what fields exist. These constraints say which
// combinations are honest: a digest is a digest and never a tag, a pack that
// requires persistence must name a volume, an operation is never a shell
// invocation, and a pack never claims a provider-native realization.
//
// The scalars below (#Sha256, #IsoDate, #IsoInstant, #Label, #AbsolutePath) are
// spelled the same way in each capability pack's own `data-models/` folder.
// They are restated there rather than shared from here because a package owns
// its data models locally, and a CUE file in another directory is a different
// package.

package packs

#Sha256: =~"^sha256:[0-9a-f]{64}$"
#IsoDate: =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
#IsoInstant: =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$"
#HttpsUrl: =~"^https://"
#Label: =~"^[a-z0-9]+(-[a-z0-9]+)*$"
#AbsolutePath: =~"^/[A-Za-z0-9._/-]+$"

#PackSourceRefRecord: {
	url:        #HttpsUrl
	checked_at: #IsoDate
	note:       string
}

#PackImageRecord: {
	architecture: "linux/amd64" | "linux/arm64" | "linux/arm64/v8" | "linux/arm/v7" |
		"linux/386" | "linux/ppc64le" | "linux/s390x"
	// Fully qualified: the registry host is explicit so nobody has to know
	// which default a tool would have applied.
	repository: =~"^[a-z0-9][a-z0-9.-]*(:[0-9]{1,5})?/[a-z0-9]"
	digest:     #Sha256
	size_bytes?: uint64
	// A tag alongside a digest reintroduces the moving pointer the digest was
	// meant to remove.
	_noTagInRepository: true & (repository !~ "/[^/]*:")
}

#PackPortRecord: {
	name:           #Label
	container_port: uint32 & >=1 & <=65535
	protocol:       "tcp" | "udp"
	exposure:       "none" | "camp" | "yard"
}

#PackProbeRecord: {
	kind:              "tcp" | "exec" | "http-get"
	port_name?:        #Label
	argv?:             [...string]
	path?:             =~"^/"
	expect_status?:    uint32 & >=100 & <=599
	initial_delay_ms:  uint32
	period_ms:         uint32 & >0
	timeout_ms:        uint32 & >0
	failure_threshold: uint32 & >0
	// A probe whose timeout exceeds its period overlaps itself and reports
	// stale results.
	_timeoutWithinPeriod: true & (timeout_ms <= period_ms)
	// An exec probe carries argv; a socket probe carries a port.
	_execHasArgv: true & (kind != "exec" | argv != _|_)
	_socketHasPort: true & (kind == "exec" | port_name != _|_)
}

#PackVolumeRecord: {
	name:                     #Label
	mount_path:               #AbsolutePath
	minimum_bytes:            uint64 & >0
	access_mode:              "single-writer" | "shared-multi-writer"
	external_storage_allowed: bool
}

#PackPersistenceRecord: {
	requirement: "required" | "not-applicable"
	volumes:     [...#PackVolumeRecord]
	rationale?:  string
	// Required persistence means at least one declared volume. Anything else
	// would let a stateful pack run on storage that vanishes with the container.
	_requiredHasVolume: true & (requirement != "required" | len(volumes) > 0)
	// Declining persistence is a decision that has to be justified.
	_declinedHasRationale: true & (requirement != "not-applicable" | rationale != _|_)
}

#PackResourceBoundsRecord: {
	cpu_millicores_min:           uint32 & >0
	cpu_millicores_max?:          uint32
	memory_bytes_min:             uint64 & >0
	memory_bytes_max?:            uint64
	ephemeral_storage_bytes_min?: uint64
}

#PackConfigFieldRecord: {
	key:            =~"^[a-z][a-zA-Z0-9]*$"
	kind:           "string" | "integer" | "boolean" | "enum" | "secret-ref" | "volume-name" | "duration-ms"
	necessity:      "required" | "optional"
	description:    string
	enum_values?:   [...string]
	minimum?:       int64
	maximum?:       int64
	default_value?: string
	// An enum without values cannot be satisfied by any input.
	_enumHasValues: true & (kind != "enum" | enum_values != _|_)
	// A default on a required field is how an unsafe value gets chosen
	// silently; a default on a secret is how one gets shared.
	_noDefaultWhenRequired: true & (necessity != "required" | default_value == _|_)
	_noSecretDefault:       true & (kind != "secret-ref" | default_value == _|_)
}

#PackOperationRecord: {
	id:                  =~"^[a-z0-9]+([.-][a-z0-9]+)*$"
	kind:                "backup" | "restore" | "migration" | "maintenance"
	profile_ref?:        string
	description:         string
	credential_delivery: "environment" | "stdin" | "file-descriptor" | "none"
	// Not a toggle. A pack operation is an argv array.
	shell:            false
	argv_builder_ref: string & !=""
}

#PackProvenanceRecord: {
	builder:           string & !=""
	build_type:        "upstream-published" | "hobo-rebuilt"
	source_repository: string
	source_revision:   string
	sbom_ref?:         string
	attestation_refs:  [...string]
	source_refs:       [...#PackSourceRefRecord]
	// A pack with no cited source is an unattributed binary.
	_hasSource: true & (len(source_refs) > 0)
}

#PackSignatureRecord: {
	algorithm:      "ed25519" | "ecdsa-p256-sha256" | "rsa-pss-sha256"
	key_id:         =~"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
	value:          =~"^[A-Za-z0-9+/]+={0,2}$"
	payload_digest: #Sha256
	signed_at:      #IsoInstant
}

#PackConformanceRecord: {
	outcome:                   "pass" | "fail" | "unknown"
	suite_ref:                 string & !=""
	evidence_checked_at:       #IsoDate
	executed_against_container: bool
}

#PackProfileClaimRecord: {
	profile_id:      =~"^[a-z0-9-]+(\\.[a-z0-9-]+)+/v[1-9][0-9]*$"
	version_range:   string & !=""
	// A pack realization is the only one a pack may claim. Advertising
	// "native" would present a container as a managed provider product.
	realization:     "pack"
	conformance_ref: string & !=""
	conformance:     "pass" | "fail" | "unknown"
}

#PackManifestRecord: {
	schema_version:            "hobo.pack-manifest/v1"
	pack_id:                   =~"^pack\\.[a-z0-9-]+(\\.[a-z0-9-]+)*/v[1-9][0-9]*$"
	pack_version:              =~"^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"
	display_name:              string & !=""
	description:               string & !=""
	runtime_models:            [...("wasm" | "oci" | "vm_iaas" | "paas" | "serverless_faas")]
	implements_profiles:       [...#PackProfileClaimRecord]
	images:                    [...#PackImageRecord]
	ports:                     [...#PackPortRecord]
	readiness_probe:           #PackProbeRecord
	liveness_probe?:           #PackProbeRecord
	startup_probe?:            #PackProbeRecord
	persistence:               #PackPersistenceRecord
	resource_bounds:           #PackResourceBoundsRecord
	config_schema:             [...#PackConfigFieldRecord]
	produces_binding_profiles: [...string]
	operations:                [...#PackOperationRecord]
	// There is no "provider-claim" member: a container the operator started on
	// their own compute has no provider account to be transferred into.
	ownership:  "yard-owned" | "migrate-on-claim"
	provenance: #PackProvenanceRecord
	conformance: #PackConformanceRecord
	signature:  #PackSignatureRecord
	// A pack must pin at least one image and produce at least one binding, or
	// nothing can run it and nothing can consume it.
	_hasImage:   true & (len(images) > 0)
	_hasBinding: true & (len(produces_binding_profiles) > 0)
	_hasProfile: true & (len(implements_profiles) > 0)
	// A pack that requires persistence must let a deployment supply storage.
	_persistentPackExposesVolumeKey: true &
		(persistence.requirement != "required" |
			len([for f in config_schema if f.kind == "volume-name" {f}]) > 0)
}

#PackConformanceStepResultRecord: {
	case_id:    string & !=""
	step_index: uint32
	ok:         bool
	detail?:    string
}

#PackConformanceReportRecord: {
	pack_id:      string & !=""
	pack_version: string & !=""
	architecture: string & !=""
	image_digest: #Sha256
	outcome:      "pass" | "fail"
	step_results: [...#PackConformanceStepResultRecord]
}
