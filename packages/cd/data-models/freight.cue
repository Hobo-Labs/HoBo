// CUE constraints for the Freight records in cd.proto (WP1, D2, D3, D18).
// Values are protobuf JSON (camelCase fields, enum names, uint64 as decimal
// strings). Proto3 JSON omits default values, so scalar fields are optional
// unless the record is meaningless without them. The file is self-contained
// (no package clause) so `cue vet -d '#Freight' freight.cue <manifest.json>`
// checks a hobo.freight-manifest/v1 document on its own.

import (
	"list"
	"strings"
	"struct"
)

#Digest:    =~"^sha256:[0-9a-f]{64}$"
#Timestamp: =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"
#Bindle:    =~"^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$"
#Slug:      =~"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"
#Text:      string & strings.MaxRunes(1024)

// Every refusal the Freight ledger and ingest return carries a remediation.
#ReasonRecord: {
	code:        string & !=""
	message?:    #Text
	remediation: string & !="" & #Text
	subject?:    #Text
}

#ArtifactKind: "ARTIFACT_KIND_WASM_COMPONENT" | "ARTIFACT_KIND_FUNCTION_BUNDLE" | "ARTIFACT_KIND_STATIC_ASSETS" | "ARTIFACT_KIND_OCI_IMAGE" | "ARTIFACT_KIND_VM_IMAGE" | "ARTIFACT_KIND_PACKAGE" | "ARTIFACT_KIND_SOURCE_TREE"

#ArtifactRef: {
	name:       string & !="" & #Text
	kind:       #ArtifactKind
	digest:     #Digest
	coordinate: string & !="" & #Text
	sizeBytes?: =~"^[0-9]+$"
	mediaType?: #Text
	ecosystem?: "oci" | "npm" | "nuget" | "pypi" | "maven" | "cargo" | "rubygems" | "git" | "http" | "store"
}

#SourceRef: {
	repository?: #Text
	commit?:     =~"^[0-9a-f]{7,64}$"
	ref?:        #Text
	ciRunId?:    #Text
	ciSystem?:   #Text
	builderId?:  #Text
}

#ProvenanceRef: {
	statementDigest: #Digest
	predicateType?:  #Text
	builderId?:      #Text
	signerIdentity?: #Text
	issuer?:         #Text
	verified?:       bool
	verifier?:       "sigstore" | "hobo-jwt"
	subjectDigests?: [...#Digest]
}

#FreightSubject: "FREIGHT_SUBJECT_UNSPECIFIED" | "FREIGHT_SUBJECT_BINDLE" | "FREIGHT_SUBJECT_RAIL"

#FreightManifestRecord: {
	schemaVersion:   "hobo.freight-manifest/v1"
	bindle:          #Bindle
	declarationHash: #Digest
	artifacts?: [...#ArtifactRef] & list.MaxItems(256)
	source?: #SourceRef
	provenance?: [...#ProvenanceRef]
	labels?: {[=~"^[a-z0-9]([a-z0-9._/-]{0,62}[a-z0-9])?$"]: #Text}
	subject?: #FreightSubject
	// A Rail version carries no artifacts (D24).
	if subject != _|_ if subject == "FREIGHT_SUBJECT_RAIL" {
		artifacts?: []
	}
}

// The hobo.freight-manifest/v1 document is the vet target for this file.
#Freight: #FreightManifestRecord

#FreightOrigin: "FREIGHT_ORIGIN_MANIFEST" | "FREIGHT_ORIGIN_ATTESTATION" | "FREIGHT_ORIGIN_SOURCE_DISCOVERY" | "FREIGHT_ORIGIN_CDEVENT" | "FREIGHT_ORIGIN_HOBO_CI" | "FREIGHT_ORIGIN_LOCAL_BUILD"

#FreightRecord: {
	schemaVersion: "hobo.cd.freight/v1"
	freightId:     #Digest
	alias:         =~"^[a-z]+-[a-z]+$"
	manifest:      #FreightManifestRecord
	origin:        #FreightOrigin
	sourceName?:   #Text
	recordedBy:    string & !=""
	recordedAt:    #Timestamp
}

#FreightYankedRecord: {
	freightId: #Digest
	reason:    string & !="" & #Text
	yankedBy:  string & !=""
	yankedAt:  #Timestamp
}

#FreightQualifiedRecord: {
	freightId:      #Digest
	campId:         string & !=""
	pipeline:       string & !=""
	node:           string & !=""
	verificationId: string & !=""
	qualifiedAt:    #Timestamp
}

#FreightApprovedRecord: {
	freightId:  #Digest
	campId:     string & !=""
	approvedBy: string & !=""
	reason:     string & !="" & #Text
	decisionId: string & !=""
	approvedAt: #Timestamp
	expiresAt:  #Timestamp
}

#FreightRetiredRecord: {
	freightId: #Digest
	reason:    string & !=""
	retiredAt: #Timestamp
}

#RetentionPolicyRecord: {
	bindle?:           #Bindle
	keepPerCamp?:      int & >=0
	keepUnpromotedMs?: =~"^[0-9]+$"
	legalHoldLabels?: [...string & !=""]
	blobGraceMs?: =~"^[0-9]+$"
}

#TrustedPublisherRecord: {
	name:     #Slug
	issuer:   =~"^https://[^/?#@]+(/[^?#]*[^/?#])?$"
	audience: string & !=""
	// At least one exact-match claim: an issuer alone would trust every repository on it.
	requiredClaims: {[string & !=""]: string & !=""} & struct.MinFields(1)
	bindles: [...#Bindle] & list.MinItems(1)
}
