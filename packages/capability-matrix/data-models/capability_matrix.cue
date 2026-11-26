// Capability matrix invariants.
//
// Protobuf pins the shape; this file pins the things a shape cannot say:
// the closed vocabularies, the digest form, the rule that availability and
// unavailability are mutually exclusive, and — the one that makes the matrix a
// matrix — that a record carries exactly one cell per primitive/runtime pair.

package capability_matrix

import "list"

#Digest: =~"^sha256:[0-9a-f]{64}$"

#BindlePrimitive: "web" | "api" | "service" | "data" | "kv" | "bucket" | "queue" | "topic" | "secretRef" | "webhook"

#BindleRuntime: "wasm" | "oci" | "vm_iaas" | "paas" | "serverless_faas"

// How a product satisfies a profile, mirrored from @hobo/capability-profiles.
#RealizationKind: "native" | "pack" | "bridge"

// The five things a cell may be covered by. They are never summed: a pack and
// a sponsor-backed fallback are both coverage and are not the same claim.
#CandidateBucket: "native" | "pack" | "bridge" | "substrate" | "sponsor"

// Derived from the buckets. `uncovered` means nothing was ever registered;
// `evidence-lapsed` means something was and no longer holds.
#CoverageVerdict: "covered" | "pack-only" | "substrate-only" | "bridge-only" | "sponsor-only" | "evidence-lapsed" | "uncovered"

#EvidenceFreshnessState: "fresh" | "absent" | "future-dated" | "aged" | "expired"

#ConformanceResult: "pass" | "fail" | "unknown"

#CandidateUnavailabilityCode: "evidence-absent" | "evidence-expired" | "evidence-aged" | "evidence-future-dated" | "trust-gate-failed" | "conformance-not-passing" | "conformance-ref-missing"

#MatrixExclusionCode: "no-declared-semantics" | "unregistered-profile" | "no-runtime-model" | "unknown-runtime-model" | "unknown-realization"

#MatrixFindingCode: "uncovered-cell" | "evidence-lapsed-cell" | "bridge-only-cell" | "sponsor-only-cell" | "substrate-only-cell" | "expiring-evidence-cell" | "missing-conformance-ref"

#MatrixFindingSeverity: "error" | "warning" | "info"

#CellKey: =~"^[a-zA-Z]+/[a-z_]+$"

// The canonical coordinate space, in the order the generator, the renderer and
// the digest all walk it. Ten primitives x five runtimes.
_primitives: ["web", "api", "service", "data", "kv", "bucket", "queue", "topic", "secretRef", "webhook"]
_runtimes: ["wasm", "oci", "vm_iaas", "paas", "serverless_faas"]
_cellKeys: [for p in _primitives for r in _runtimes {"\(p)/\(r)"}]

#CandidateUnavailabilityRecord: {
	code:   #CandidateUnavailabilityCode
	detail: string & !=""
}

#CapabilityMatrixCandidateRecord: {
	primitive:     #BindlePrimitive
	runtime:       #BindleRuntime
	definition_id: string & !=""
	provider_id:   string & !=""
	profile_id:    string & !=""
	realization:   #RealizationKind
	bucket:        #CandidateBucket
	available:     bool
	evidence_state: #EvidenceFreshnessState
	// Zero stands for "no evidence record at all"; a real expiry is positive.
	evidence_expires_at_ms: int & >=0
	conformance:            #ConformanceResult
	conformance_ref:        string
	unavailability: [...#CandidateUnavailabilityRecord]

	// Availability is exactly the absence of a reason not to be available.
	// This is the invariant that stops a cell being scored optimistically by
	// recording a reason and calling the candidate usable anyway.
	_availableIffNoReason: true & (available == (len(unavailability) == 0))

	// Stale, absent, aged or future-dated evidence can never back a selectable
	// candidate. The converse does not hold: fresh evidence still loses to a
	// failed conformance run.
	_availableImpliesFresh: true & (!available || evidence_state == "fresh")

	// A definition claiming coverage must name the suite that proves it.
	_availableClaimsAreCheckable: true & (!available || conformance_ref != "")
}

#CapabilityMatrixBucketRecord: {
	available: [...string & !=""]
	unavailable: [...string & !=""]

	// Sorted and unique, so the digest is a statement about content rather
	// than about the order a catalog happened to be walked in.
	_availableSorted:   true & list.IsSorted(available, list.Ascending) & list.UniqueItems(available)
	_unavailableSorted: true & list.IsSorted(unavailable, list.Ascending) & list.UniqueItems(unavailable)
	// One definition is never both. If any claim is usable, it is usable.
	_disjoint: true & (len([for id in unavailable if list.Contains(available, id) {id}]) == 0)
}

#CapabilityMatrixBucketsRecord: {
	native:    #CapabilityMatrixBucketRecord
	pack:      #CapabilityMatrixBucketRecord
	bridge:    #CapabilityMatrixBucketRecord
	substrate: #CapabilityMatrixBucketRecord
	sponsor:   #CapabilityMatrixBucketRecord
}

#CapabilityMatrixCellRecord: {
	key:       #CellKey
	primitive: #BindlePrimitive
	runtime:   #BindleRuntime
	verdict:   #CoverageVerdict
	buckets:   #CapabilityMatrixBucketsRecord
	candidates: [...#CapabilityMatrixCandidateRecord]

	// The key is not free-form: it names the coordinate the cell occupies.
	_keyMatchesCoordinates: true & (key == "\(primitive)/\(runtime)")

	// A candidate filed under the wrong coordinate would make every per-cell
	// count wrong while the grid still looked complete.
	_candidatesBelongHere: true & (len([
		for c in candidates if c.primitive != primitive || c.runtime != runtime {c},
	]) == 0)

	// The bucket a candidate counts towards is reported once, in the cell it
	// occupies; a bucket may only list definitions the cell can account for.
	_bucketsAreAccountedFor: true & (len([
		for b in [buckets.native, buckets.pack, buckets.bridge, buckets.substrate, buckets.sponsor]
		for id in b.available + b.unavailable
		if len([for c in candidates if c.definition_id == id {c}]) == 0 {id},
	]) == 0)

	// `covered` is reserved for public provider-native coverage that is
	// selectable now. Every other verdict follows from the buckets the same
	// way, and the generator derives it rather than accepting it.
	_coveredMeansNative: true & ((verdict == "covered") == (len(buckets.native.available) > 0))
}

#CapabilityMatrixExclusionRecord: {
	definition_id: string & !=""
	// Empty when the exclusion is about the definition rather than one claim.
	profile_id: string
	code:       #MatrixExclusionCode
	detail:     string & !=""
}

#CapabilityMatrixRecord: {
	schema_version:          "hobo.capability-matrix/v1"
	evaluated_at_ms:         int
	profile_registry_digest: #Digest
	trust_bundle_digest:     #Digest
	cells: [...#CapabilityMatrixCellRecord]
	excluded: [...#CapabilityMatrixExclusionRecord]
	digest: #Digest

	// Grid completeness. A matrix carries one cell per primitive/runtime pair,
	// in canonical order — no sparse "only the interesting cells" form exists,
	// because an omitted cell and an empty cell would be indistinguishable and
	// only one of them is honest.
	_completeGrid: true & (len(cells) == len(_cellKeys))
	_canonicalOrder: true & (len([
		for i, c in cells if c.key != _cellKeys[i] {c},
	]) == 0)
}

#CapabilityMatrixFindingRecord: {
	code:      #MatrixFindingCode
	severity:  #MatrixFindingSeverity
	primitive: #BindlePrimitive
	runtime:   #BindleRuntime
	detail:    string & !=""
	definition_ids: [...string & !=""]
}

#CoverageSummaryRecord: {
	verdict: #CoverageVerdict
	cells:   uint & <=len(_cellKeys)
}

#CapabilityMatrixValidationRecord: {
	evaluated_at_ms:   int
	matrix_digest:     #Digest
	expiry_horizon_ms: int & >0
	summary: [...#CoverageSummaryRecord]
	findings: [...#CapabilityMatrixFindingRecord]

	// One entry per verdict, always, so a consumer never has to distinguish
	// "zero cells" from "the generator forgot this verdict".
	_summaryCoversEveryVerdict: true & (len(summary) == 7)
	// Every cell is counted exactly once.
	_summaryTotalsTheGrid: true & (list.Sum([for s in summary {s.cells}]) == len(_cellKeys))
}
