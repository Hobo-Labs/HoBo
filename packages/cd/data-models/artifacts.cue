// CUE constraints for the artifact store and provenance records in cd.proto
// (WP3, C14, D3, D18). Values are protobuf JSON (camelCase fields, enum names,
// uint64 as decimal strings); proto3 JSON omits defaults, so scalar fields are
// optional unless the record is meaningless without them. Self-contained (no
// package clause): `cue vet -d '#ArtifactStoredRecord' artifacts.cue x.json`.

import "strings"

#Digest:    =~"^sha256:[0-9a-f]{64}$"
#Timestamp: =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"
#Text:      string & strings.MaxRunes(1024) & !~"[\\x00-\\x1f\\x7f]"
#Backend:   "filesystem" | "s3-compatible" | "memory"

#ArtifactKind: "ARTIFACT_KIND_WASM_COMPONENT" | "ARTIFACT_KIND_FUNCTION_BUNDLE" | "ARTIFACT_KIND_STATIC_ASSETS" | "ARTIFACT_KIND_OCI_IMAGE" | "ARTIFACT_KIND_VM_IMAGE" | "ARTIFACT_KIND_PACKAGE" | "ARTIFACT_KIND_SOURCE_TREE"

#Ecosystem: "oci" | "npm" | "nuget" | "pypi" | "maven" | "cargo" | "rubygems" | "git" | "http" | "store"

// A coordinate never embeds credentials (`scheme://user:pass@host`) or whitespace.
#Coordinate: #Text & !="" & !~"^[A-Za-z][A-Za-z0-9+.-]*://[^/@]*@" & !~"\\s"

// Digest-pinned and payload-free: an ArtifactRef points at bytes, it never carries them.
#ArtifactRef: {
	name:       #Text & !=""
	kind:       #ArtifactKind
	digest:     #Digest
	coordinate: #Coordinate
	sizeBytes?: =~"^[0-9]+$"
	mediaType?: #Text
	ecosystem?: #Ecosystem
}

// A blob the artifact store holds; the coordinate is the store's own locator.
#StoredArtifactRef: #ArtifactRef & {
	digest:     _
	coordinate: =~"^store://(filesystem|s3-compatible|memory)/sha256:[0-9a-f]{64}$"
	ecosystem:  "store"
	sizeBytes:  =~"^[0-9]+$"
}

// artifact.Stored on cd-artifact-<digest>.
#ArtifactStoredRecord: {
	artifact: #StoredArtifactRef
	backend:  #Backend
	storedAt: #Timestamp
	// The stored coordinate names the backend that stored it and the same digest.
	artifact: coordinate: "store://\(backend)/\(artifact.digest)"
}

// artifact.Deleted on cd-artifact-<digest>: a reason is mandatory (audit).
#ArtifactDeletedRecord: {
	digest:    #Digest
	backend:   #Backend
	reason:    #Text & !=""
	deletedAt: #Timestamp
}

// A verified provenance reference the provenance verifier returns.
#ProvenanceRef: {
	statementDigest: #Digest
	predicateType:   "https://slsa.dev/provenance/v1"
	builderId:       #Text & !=""
	signerIdentity:  #Text & !=""
	issuer?:         #Text
	verified:        true
	verifier:        "sigstore" | "hobo-jwt"
	subjectDigests: [#Digest, ...#Digest]
}

// The trust policy `createProvenanceVerifier` parses (opaque JsonObject on the port).
#ProvenanceTrustPolicy: close({
	builderIds?: [...(#Text & !="")]
	signerIdentities?: [...(#Text & !="")]
	sigstore?: close({
		trustedRoot: "public-good-seed" | {...}
		issuers: [#Text & !="", ...(#Text & !="")]
		ctlogThreshold?: int & >=1 & <=16
		tlogThreshold?:  int & >=1 & <=16
	})
	hoboJwt?: close({
		jwks: keys: [{...}, ...{...}]
		issuer:   #Text & !=""
		audience: #Text & !=""
	})
})

// Every refusal the artifact store, verifier and provenance verifier return.
#ArtifactReasonCode: "artifact-digest-invalid" | "artifact-corrupt" | "artifact-missing" | "artifact-too-large" | "artifact-backend-unavailable" | "artifact-backend-rejected" | "artifact-credential-unavailable" | "artifact-store-config-invalid" | "artifact-journal-conflict" | "artifact-coordinate-invalid" | "artifact-coordinate-mutable" | "artifact-ecosystem-unsupported" | "artifact-registry-unavailable" | "artifact-registry-not-found" | "artifact-registry-malformed" | "artifact-digest-mismatch" | "artifact-registry-digest-incomparable" | "artifact-size-mismatch" | "artifact-unverifiable"

#ProvenanceReasonCode: "provenance-unsigned" | "provenance-bundle-invalid" | "provenance-verifier-unconfigured" | "provenance-payload-mismatch" | "provenance-signature-invalid" | "provenance-signer-untrusted" | "provenance-issuer-untrusted" | "provenance-statement-invalid" | "provenance-builder-untrusted" | "provenance-subject-mismatch"

#ReasonRecord: {
	code:        #ArtifactReasonCode | #ProvenanceReasonCode
	message?:    #Text
	remediation: #Text & !=""
	subject?:    #Text
}
