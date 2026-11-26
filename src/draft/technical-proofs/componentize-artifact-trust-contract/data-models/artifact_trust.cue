package componentize_artifact_trust

#Digest: string & =~"^sha256:[a-f0-9]{64}$"

#ProvenanceTier: "builder-observed" | "sandboxed-builder" | "slsa-build-l3"

#RefusalReason:
	"candidate.required" |
	"artifact.required" |
	"artifact.digest_mismatch" |
	"artifact.digest_invalid" |
	"artifact.uri_digest_mismatch" |
	"artifact.coordinate_scope" |
	"signature.required" |
	"signature.alg" |
	"signature.key_untrusted" |
	"signature.payload_digest_mismatch" |
	"signature.invalid" |
	"provenance.builder_untrusted" |
	"provenance.tier_below_policy_minimum" |
	"provenance.subject_digest_mismatch" |
	"conformance.required" |
	"conformance.suite_untrusted" |
	"conformance.failed"

#ArtifactRef: {
	coordinate: string & !=""
	version:    string & !=""
	media_type: string & !=""
	bytes:      string & !=""
	digest:     #Digest
	uri:        string & !=""
}

#SlsaBuilder: {
	id: string & !=""
}

#SlsaSubject: {
	name:   string & !=""
	digest: #Digest
}

#SlsaPayload: {
	builder:         #SlsaBuilder
	subject:         #SlsaSubject
	issued_at:       string & !=""
	provenance_tier: #ProvenanceTier
}

#SlsaProvenance: {
	schema: "slsa.dev/provenance/v1"
	slsa:   #SlsaPayload
}

#ConformanceReportRef: {
	schema: "hobo.conformance.report-ref/v1"
	digest: #Digest
}

#ArtifactSignature: {
	alg:            "Ed25519"
	key_id:         string & !=""
	public_key_pem: string & !=""
	payload_digest: #Digest
	value:          string & !=""
}

#SignedArtifactCandidate: {
	artifact:    #ArtifactRef
	provenance:  #SlsaProvenance
	conformance: #ConformanceReportRef
	signature:   #ArtifactSignature
}

#TrustBoundary: {
	trusted_key_ids:            [...string] & [_, ...]
	trusted_builder_ids:        [...string] & [_, ...]
	required_conformance_suites: [...string] & [_, ...]
	allowed_coordinate_scopes:  [...string] & [_, ...]
	minimum_provenance_tier:    #ProvenanceTier
}

#InstallVerdictOk: {
	ok:                    true
	reasons:               []
	available_to_matching: true
	selected_by_matching:  false
	assurance:             "integrity-and-conformance-verified"
}

#ArtifactPublishedEvent: {
	type:            "artifact.Published"
	ref:             #ArtifactRef
	key_id:          string & !=""
	provenance_tier: #ProvenanceTier
}

#ArtifactInstallVerifiedEvent: {
	type:            "artifact.InstallVerified"
	ref:             #ArtifactRef
	key_id:          string & !=""
	provenance_tier: #ProvenanceTier
}

#ArtifactInstallRefusedEvent: {
	type:    "artifact.InstallRefused"
	ref:     #ArtifactRef | null
	reasons: [#RefusalReason, ...]
}
