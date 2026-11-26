/**
 * A content digest over a derived matrix.
 *
 * The point is attribution: when a cell stops being covered, the digest that
 * changed says so, and the change is traceable to a definition or an expiry
 * rather than to iteration order. Canonicalization is `@hobo/trust`'s — the
 * same bytes that back evidence and verdict digests — so a matrix digest joins
 * against the evidence it was derived from instead of living in its own
 * dialect.
 */
import { type CanonicalValue, sha256Of } from "@hobo/trust";

import type { CapabilityMatrixCandidate } from "./candidate.js";
import type {
	CapabilityMatrix,
	CapabilityMatrixBucket,
	CapabilityMatrixBuckets,
	CapabilityMatrixCell,
	CapabilityMatrixExclusion,
} from "./matrix.js";

function bucketBody(bucket: CapabilityMatrixBucket): CanonicalValue {
	return {
		available: [...bucket.available],
		unavailable: [...bucket.unavailable],
	};
}

function bucketsBody(buckets: CapabilityMatrixBuckets): CanonicalValue {
	return {
		native: bucketBody(buckets.native),
		pack: bucketBody(buckets.pack),
		bridge: bucketBody(buckets.bridge),
		substrate: bucketBody(buckets.substrate),
		sponsor: bucketBody(buckets.sponsor),
	};
}

function candidateBody(candidate: CapabilityMatrixCandidate): CanonicalValue {
	return {
		definitionId: candidate.definitionId,
		providerId: candidate.providerId,
		profileId: candidate.profileId,
		realization: candidate.realization,
		bucket: candidate.bucket,
		available: candidate.available,
		evidenceState: candidate.evidenceState,
		evidenceExpiresAtMs: candidate.evidenceExpiresAtMs,
		conformance: candidate.conformance,
		conformanceRef: candidate.conformanceRef,
		unavailability: candidate.unavailability.map((entry) => ({
			code: entry.code,
			detail: entry.detail,
		})),
	};
}

function cellBody(cell: CapabilityMatrixCell): CanonicalValue {
	return {
		key: cell.key,
		verdict: cell.verdict,
		buckets: bucketsBody(cell.buckets),
		candidates: cell.candidates.map(candidateBody),
	};
}

function exclusionBody(exclusion: CapabilityMatrixExclusion): CanonicalValue {
	return {
		definitionId: exclusion.definitionId,
		profileId: exclusion.profileId,
		code: exclusion.code,
		detail: exclusion.detail,
	};
}

/**
 * The body a matrix digest is taken over: everything except the digest itself,
 * which is a statement *about* the body.
 */
export function capabilityMatrixDigestBody(
	matrix: Omit<CapabilityMatrix, "digest">,
): CanonicalValue {
	return {
		schemaVersion: matrix.schemaVersion,
		evaluatedAtMs: matrix.evaluatedAtMs,
		profileRegistryDigest: matrix.profileRegistryDigest,
		trustBundleDigest: matrix.trustBundleDigest,
		cells: matrix.cells.map(cellBody),
		excluded: matrix.excluded.map(exclusionBody),
	};
}

export function capabilityMatrixDigest(
	matrix: Omit<CapabilityMatrix, "digest">,
): string {
	return sha256Of(capabilityMatrixDigestBody(matrix));
}
