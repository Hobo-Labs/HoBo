// CUE constraints for the Freight-source records in cd.proto (WP2, D3, D24).
// Values are protobuf JSON (camelCase fields, enum names, uint64 as decimal
// strings). Proto3 JSON omits defaults, so scalars are optional unless the
// record is meaningless without them. The file is self-contained (no package
// clause; every definition is prefixed #Source* so it unifies with the other
// data-models files): `cue vet -d '#SourceFreightSource' sources.cue x.json`.
//
// These mirror the parse boundary `parseFreightSource` (src/sources/parse.ts):
// what it returns vets clean here; what it refuses for a structural reason
// fails here too. Driver-specific checks (locator grammar per ecosystem,
// regex compilation, SemVer range grammar) stay in the parser.

import (
	"list"
	"strings"
)

#SourceDigest:    =~"^sha256:[0-9a-f]{64}$"
#SourceSlug:      =~"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"
#SourceBindle:    =~"^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$"
#SourceText:      string & strings.MaxRunes(1024)
#SourceTimestamp: =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"
#SourceUint64:    =~"^[0-9]{1,20}$"

#SourceKind: "SUBSCRIPTION_KIND_OCI_REPOSITORY" | "SUBSCRIPTION_KIND_GIT_REPOSITORY" | "SUBSCRIPTION_KIND_PACKAGE_REGISTRY" | "SUBSCRIPTION_KIND_HTTP_INDEX" | "SUBSCRIPTION_KIND_HOBO_CI" | "SUBSCRIPTION_KIND_HOBO_RAIL"

#SourceSelection: "SELECTION_STRATEGY_SEMVER" | "SELECTION_STRATEGY_NEWEST_BUILD" | "SELECTION_STRATEGY_LEXICAL" | "SELECTION_STRATEGY_NEWEST_COMMIT"

#SourceAssembly: "ASSEMBLY_RULE_INDEPENDENT" | "ASSEMBLY_RULE_SAME_VERSION" | "ASSEMBLY_RULE_SAME_COMMIT"

#SourceArtifactKind: "ARTIFACT_KIND_WASM_COMPONENT" | "ARTIFACT_KIND_FUNCTION_BUNDLE" | "ARTIFACT_KIND_STATIC_ASSETS" | "ARTIFACT_KIND_OCI_IMAGE" | "ARTIFACT_KIND_VM_IMAGE" | "ARTIFACT_KIND_PACKAGE" | "ARTIFACT_KIND_SOURCE_TREE"

// Paths are repository-relative and never climb.
#SourcePath: string & =~"^[^/]" & !~"\\.\\." & strings.MaxRunes(512)

// A locator never embeds credentials (I9): no URL userinfo, no token shapes.
#SourceLocator: #SourceText & =~"^[^\\s]+$" & !~"://[^/@\\s]+:[^/@\\s]+@" & !~"gh[pousr]_[A-Za-z0-9]{30,}" & !~"glpat-[A-Za-z0-9_-]{20,}"

#SourceSubscription: {
	name:          #SourceSlug
	kind:          #SourceKind
	locator:       #SourceLocator
	ecosystem?:    "npm" | "pypi" | "maven" | "nuget" | "cargo" | "rubygems"
	selection:     #SourceSelection
	semverRange?:  string & strings.MaxRunes(256)
	allowPattern?: string & strings.MaxRunes(256)
	ignorePatterns?: [...(string & strings.MaxRunes(256))]
	includePaths?: [...#SourcePath]
	excludePaths?: [...#SourcePath]
	branch?:            =~"^[A-Za-z0-9._/-]{1,200}$"
	discoveryLimit:     int & >=1 & <=100
	credentialRef?:     =~"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$"
	requireProvenance?: bool
	trustedBuilderIds?: [...#SourceText]
	trustedSignerIdentities?: [...#SourceText]
	artifactName?: #SourceText
	artifactKind?: #SourceArtifactKind

	// Package registries name their ecosystem.
	if kind == "SUBSCRIPTION_KIND_PACKAGE_REGISTRY" {
		ecosystem: _
	}

	// Builder/signer pins are enforced only under requireProvenance.
	if trustedBuilderIds != _|_ || trustedSignerIdentities != _|_ {
		requireProvenance: true
	}

	// Only OCI referrers carry attestations a source can verify.
	if requireProvenance != _|_ if requireProvenance {
		kind: "SUBSCRIPTION_KIND_OCI_REPOSITORY"
	}

	// HTTP indexes and CI outputs declare what they deliver.
	if kind == "SUBSCRIPTION_KIND_HTTP_INDEX" {
		artifactKind: _
	}
	if kind == "SUBSCRIPTION_KIND_HOBO_CI" {
		artifactKind: _
		artifactName: _
		selection:    "SELECTION_STRATEGY_NEWEST_BUILD"
	}

	// A branch is a Git concept and is tracked by newest commit.
	if branch != _|_ {
		kind:      "SUBSCRIPTION_KIND_GIT_REPOSITORY"
		selection: "SELECTION_STRATEGY_NEWEST_COMMIT"
	}
	if semverRange != _|_ {
		selection: "SELECTION_STRATEGY_SEMVER"
	}
}

// hobo.cd.source/v1: the record `source.Defined` carries.
#SourceFreightSource: {
	schemaVersion: "hobo.cd.source/v1"
	name:          #SourceSlug
	bindle:        #SourceBindle
	subscriptions: [#SourceSubscription, ...#SourceSubscription] & list.MaxItems(16)
	assembly:       #SourceAssembly
	automatic?:     bool
	pollIntervalMs: #SourceUint64
	definedBy:      string & !="" & #SourceText

	// Pairing rules need something to pair.
	if assembly != "ASSEMBLY_RULE_INDEPENDENT" {
		subscriptions: list.MinItems(2)
	}

	// A Rail source has exactly one HOBO_RAIL subscription naming the Rail (D24).
	if list.Contains([for s in subscriptions {s.kind}], "SUBSCRIPTION_KIND_HOBO_RAIL") {
		subscriptions: [{locator: bindle}]
		assembly: "ASSEMBLY_RULE_INDEPENDENT"
	}
}

#SourceArtifactRef: {
	name?:      #SourceText
	kind?:      #SourceArtifactKind
	digest:     #SourceDigest
	coordinate: string & !="" & #SourceText
	sizeBytes?: #SourceUint64
	mediaType?: #SourceText
	ecosystem?: "oci" | "npm" | "nuget" | "pypi" | "maven" | "cargo" | "rubygems" | "git" | "http" | "store"
}

#SourceProvenanceRef: {
	statementDigest: #SourceDigest
	predicateType?:  #SourceText
	builderId?:      #SourceText
	signerIdentity?: #SourceText
	issuer?:         #SourceText
	verified?:       bool
	verifier?:       "sigstore" | "hobo-jwt"
	subjectDigests?: [...#SourceDigest]
}

// The record `source.ArtifactDiscovered` carries.
#SourceDiscoveredArtifact: {
	source:       #SourceSlug
	subscription: #SourceSlug
	artifact:     #SourceArtifactRef
	version:      string & !="" & strings.MaxRunes(256)
	commit?:      =~"^[0-9a-f]{7,64}$"
	discoveredAt: #SourceTimestamp
	provenance?: [...#SourceProvenanceRef]
}

// The cd.proto types this file constrains, under their protobuf names.
#SubscriptionKind:         #SourceKind
#SelectionStrategy:        #SourceSelection
#AssemblyRule:             #SourceAssembly
#SubscriptionRecord:       #SourceSubscription
#FreightSourceRecord:      #SourceFreightSource
#DiscoveredArtifactRecord: #SourceDiscoveredArtifact

#SourceReasonCode: "source-invalid" | "source-unknown" | "source-unauthorized" | "source-driver-unavailable" | "source-provenance-unsupported" | "source-provenance-missing" | "source-provenance-rejected" | "source-rate-limited" | "source-unreachable" | "source-upstream-invalid" | "source-auth-failed" | "source-not-found" | "source-older-than-high-water" | "source-filtered" | "source-rail-retired" | "source-freight-refused" | "source-transport-not-binary-safe" | "source-git-capability-missing" | "unverified-trigger"

#SourceReason: {
	code:        string & !=""
	message?:    #SourceText
	remediation: string & !="" & #SourceText
	subject?:    #SourceText
}

// The meta of a `source.ArtifactDiscovered` event: the subscription's cursor
// after the poll, the outcome, and why. The first reason of a skip carries a
// source reason code; later reasons may be the ledger's or verifier's own.
#SourceDiscoveryMeta: {
	idempotencyKey: =~"^discovered:[0-9a-f]{64}$"
	cursor:         string & strings.MaxRunes(4096)
	outcome:        "recorded" | "skipped" | "deferred" | "refused"
	reasons: [...#SourceReason]
	freightIds: [...#SourceDigest]
	decisionId: string & !=""

	if outcome == "recorded" {
		freightIds: [_, ...]
	}
	if outcome == "skipped" || outcome == "refused" {
		reasons: [{code: #SourceReasonCode}, ...]
	}
}
