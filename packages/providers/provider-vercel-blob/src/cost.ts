/**
 * What each port call costs on Vercel Blob, in the classes Blob bills.
 *
 * Definitions (https://vercel.com/docs/vercel-blob/usage-and-pricing, page
 * dated 2026-09-23, read 2026-11-11):
 *
 * - a **simple operation** is a blob read that is a cache MISS, or a metadata
 *   read. Every read here is `get(..., { useCache: false })`, which serves
 *   from origin storage (https://vercel.com/docs/vercel-blob/private-storage#consistent-reads),
 *   so each is counted as one simple operation; the read also bills Blob Data
 *   Transfer and Fast Origin Transfer for the body's bytes.
 * - an **advanced operation** is an upload, copy or list. Every `put` here is
 *   one, whether or not its condition held: the docs do not say that a
 *   refused upload is free, so it is budgeted as billed.
 * - a **delete** is free, but counts against the advanced-operation rate limit
 *   (Pro: 4,500/min).
 *
 * The figures are the uncontended path of each call, counted by the SDK calls
 * the binding makes (`meterVercelBlobSdk` counts the same calls, and
 * `test/blob-cost.test.ts` asserts the two agree). A conditional write that
 * loses a race to another writer re-reads and retries: each extra round adds
 * `conflictRound`. Whether a read of a missing blob (a 404) bills a simple
 * operation is not documented; it is counted as one.
 */

// public-contract: per-operation Blob cost the relay meters against.
export const VERCEL_BLOB_EPHEMERAL_COST = Object.freeze({
	get: { simple: 1, advanced: 0, deletes: 0 },
	/** Per distinct key asked: one origin read each, in parallel. */
	getMany: { simple: 1, advanced: 0, deletes: 0, perKey: true },
	/** A missing key: one create-only upload. */
	putIfAbsent: { simple: 0, advanced: 1, deletes: 0 },
	/** A live key: the refused upload, then the read that confirms it is live. */
	"putIfAbsent.lost": { simple: 1, advanced: 1, deletes: 0 },
	/** An expired blob still stored: the refused upload, the read, the conditional replace. */
	"putIfAbsent.replacesExpired": { simple: 1, advanced: 2, deletes: 0 },
	/** Read for the ETag and version, then the ETag-conditional upload. */
	compareAndSet: { simple: 1, advanced: 1, deletes: 0 },
	/** A stale or absent version: the read only. */
	"compareAndSet.stale": { simple: 1, advanced: 0, deletes: 0 },
	/** Read (to report whether a live key was removed), then the ETag-conditional delete. */
	delete: { simple: 1, advanced: 0, deletes: 1 },
	/** Read, then the ETag-conditional upload of the new count. */
	increment: { simple: 1, advanced: 1, deletes: 0 },
	/** Read, then the ETag-conditional rewrite with the new expiry. */
	expire: { simple: 1, advanced: 1, deletes: 0 },
	"lock.acquire": { simple: 0, advanced: 1, deletes: 0 },
	"lock.renew": { simple: 1, advanced: 1, deletes: 0 },
	"lock.release": { simple: 1, advanced: 0, deletes: 1 },
	/** increment(seq) + putIfAbsent(entry) + delete(evicted); no delete until the ring first fills. */
	"ring.append": { simple: 2, advanced: 2, deletes: 1 },
	/** get(seq) + one read per sequence in the window. */
	"ring.read": { simple: 1, advanced: 0, deletes: 0, perKey: true },
	/** One lost conditional write: the re-read and the retried write. */
	conflictRound: { simple: 1, advanced: 1, deletes: 0 },
	/** One page of up to 1,000 pathnames for the purge. */
	"purge.listPage": { simple: 0, advanced: 1, deletes: 0 },
} as const);

export type VercelBlobEphemeralOperation =
	keyof typeof VERCEL_BLOB_EPHEMERAL_COST;

/**
 * Vercel Blob prices (vercel.com/pricing, read 2026-11-11). Pro bills usage
 * against the plan's $20 monthly credit, then on demand. Hobby includes the
 * allowances below and blocks Blob for 30 days once one is exceeded
 * (https://vercel.com/docs/vercel-blob/usage-and-pricing#hobby). Storage and
 * operation prices are regional; these are the published defaults (the
 * pricing example uses them for iad1). Blob Data Transfer on Pro is
 * "Included in Flat Rate CDN"; the docs' iad1 example prices it at $0.05/GB
 * and Fast Origin Transfer at $0.06/GB.
 */
export const VERCEL_BLOB_PRICING = Object.freeze({
	readOn: "2026-11-11",
	pro: {
		usdPerMillionSimpleOperations: 0.4,
		usdPerMillionAdvancedOperations: 5,
		usdPerGbMonthStorage: 0.023,
		monthlyCreditUsd: 20,
	},
	hobbyIncludedPerMonth: {
		simpleOperations: 10_000,
		advancedOperations: 2_000,
		storageGb: 1,
		dataTransferGb: 10,
	},
	/** Operations per minute (https://vercel.com/docs/vercel-blob/usage-and-pricing#operation-rate-limits). */
	rateLimitPerMinute: {
		hobby: { simple: 1_200, advanced: 900 },
		pro: { simple: 7_200, advanced: 4_500 },
	},
} as const);

/** Billable usage counted from SDK calls. */
export type VercelBlobOperationCounts = {
	readonly simple: number;
	readonly advanced: number;
	readonly deletes: number;
};

/** Dollars for a period's counted operations at the Pro rates above (before the monthly credit). */
export function vercelBlobProOperationsUsd(
	counts: VercelBlobOperationCounts,
): number {
	const { pro } = VERCEL_BLOB_PRICING;
	return (
		(counts.simple / 1_000_000) * pro.usdPerMillionSimpleOperations +
		(counts.advanced / 1_000_000) * pro.usdPerMillionAdvancedOperations
	);
}
