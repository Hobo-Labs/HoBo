/**
 * Dataset digests — the only thing a verification ever carries across a port
 * (ADR-0177 decision 9: counts and digests, never rows).
 *
 * A dataset digest is order-independent. Each record digests on its own, and
 * a bucket combines its records by addition modulo 2^256, so a binding can
 * stream rows in whatever order its engine returns them and two engines with
 * different native orderings still agree. Records land in buckets by a hash of
 * their tenant and key, which lets a mismatch be localised to a bucket and
 * re-checked without re-reading the whole dataset.
 */
import type { CanonicalRecord } from "./canonical.js";
import { recordDigest } from "./canonical.js";
import { DataCoreError } from "./errors.js";
import { canonicalEncode, sha256Hex } from "./json.js";

// public-contract: the schema id a dataset digest is published under.
export const DATASET_DIGEST_CONTRACT = "hobo.dataset-digest/v1";

export const DEFAULT_DIGEST_BUCKETS = 16;
export const MAX_DIGEST_BUCKETS = 4096;

const MODULUS = 2n ** 256n;
const ZERO_DIGEST = "0".repeat(64);

// domain-view: computed evidence; wire form is BucketDigest in data-models/data_core.proto.
export interface BucketDigest {
	readonly bucket: number;
	readonly count: number;
	readonly digest: string;
}

// domain-view: computed evidence; wire form is DatasetDigest in data-models/data_core.proto.
export interface DatasetDigest {
	readonly contract: typeof DATASET_DIGEST_CONTRACT;
	readonly dataset: string;
	/** Empty string when the digest spans every tenant. */
	readonly tenant: string;
	readonly count: number;
	readonly digest: string;
	readonly buckets: readonly BucketDigest[];
}

export function parseBucketCount(buckets: number): number {
	if (
		!Number.isInteger(buckets) ||
		buckets < 1 ||
		buckets > MAX_DIGEST_BUCKETS
	) {
		throw new DataCoreError(
			"VERIFICATION_FAILED",
			`bucket count must be an integer from 1 to ${MAX_DIGEST_BUCKETS}`,
			{ detail: { buckets } },
		);
	}
	return buckets;
}

/** Deterministic bucket for a record, identical in every engine. */
export function bucketOf(tenant: string, key: string, buckets: number): number {
	const head = sha256Hex(canonicalEncode([tenant, key])).slice(0, 8);
	return Number.parseInt(head, 16) % buckets;
}

function addDigests(left: string, right: string): string {
	return ((BigInt(`0x${left}`) + BigInt(`0x${right}`)) % MODULUS)
		.toString(16)
		.padStart(64, "0");
}

/**
 * Streaming accumulator a binding feeds rows into. It holds one running sum
 * per bucket — constant memory in the number of rows.
 */
export class DatasetDigestBuilder {
	private readonly counts: number[];
	private readonly sums: string[];

	constructor(
		private readonly dataset: string,
		private readonly tenant: string,
		private readonly buckets: number = DEFAULT_DIGEST_BUCKETS,
	) {
		parseBucketCount(buckets);
		this.counts = Array.from({ length: buckets }, () => 0);
		this.sums = Array.from({ length: buckets }, () => ZERO_DIGEST);
	}

	add(tenant: string, key: string, record: CanonicalRecord): void {
		const bucket = bucketOf(tenant, key, this.buckets);
		this.counts[bucket] = (this.counts[bucket] ?? 0) + 1;
		this.sums[bucket] = addDigests(
			this.sums[bucket] ?? ZERO_DIGEST,
			recordDigest(tenant, key, record),
		);
	}

	finish(): DatasetDigest {
		const buckets = this.counts.map((count, bucket) =>
			Object.freeze({
				bucket,
				count,
				digest: this.sums[bucket] ?? ZERO_DIGEST,
			}),
		);
		const count = this.counts.reduce((total, value) => total + value, 0);
		const digest = sha256Hex(
			canonicalEncode(buckets.map((entry) => [entry.count, entry.digest])),
		);
		return Object.freeze({
			contract: DATASET_DIGEST_CONTRACT,
			dataset: this.dataset,
			tenant: this.tenant,
			count,
			digest,
			buckets: Object.freeze(buckets),
		});
	}
}

export interface DigestComparison {
	readonly equal: boolean;
	readonly sourceCount: number;
	readonly targetCount: number;
	/** Buckets whose count or digest differ; empty when equal. */
	readonly mismatchedBuckets: readonly number[];
}

/**
 * Compare two digests bucket by bucket. Digests taken with different bucket
 * counts are never equal — they are not comparable, and saying so loudly is
 * better than a mismatch nobody can localise.
 */
export function compareDigests(
	source: DatasetDigest,
	target: DatasetDigest,
): DigestComparison {
	if (source.buckets.length !== target.buckets.length) {
		throw new DataCoreError(
			"VERIFICATION_FAILED",
			"digests were taken with different bucket counts and cannot be compared",
			{
				detail: {
					sourceBuckets: source.buckets.length,
					targetBuckets: target.buckets.length,
				},
			},
		);
	}
	const mismatchedBuckets: number[] = [];
	source.buckets.forEach((entry, index) => {
		const other = target.buckets[index];
		if (
			other === undefined ||
			other.count !== entry.count ||
			other.digest !== entry.digest
		) {
			mismatchedBuckets.push(index);
		}
	});
	return Object.freeze({
		equal: mismatchedBuckets.length === 0,
		sourceCount: source.count,
		targetCount: target.count,
		mismatchedBuckets: Object.freeze(mismatchedBuckets),
	});
}
