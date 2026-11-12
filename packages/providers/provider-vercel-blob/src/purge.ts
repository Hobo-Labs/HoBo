/**
 * A bounded sweep of expired key blobs, for a scheduled job (a cron route),
 * never a request path.
 *
 * Blob keeps no TTL and a listing returns no body, so expiry is learned in one
 * of two ways:
 *
 * - **Without a read.** Every write puts an expiry of at most "now + TTL" in
 *   the record, and the longest TTL the port accepts is
 *   `EPHEMERAL_STATE_MAX_TTL_MS` (30 days); an `increment` that keeps its
 *   window keeps an earlier expiry. So a blob last uploaded more than the
 *   longest TTL ago (plus `clockSkewMs`, for writers whose clocks run ahead of
 *   Blob's `uploadedAt`) is expired whatever it holds, and is deleted on its
 *   listed ETag without being read.
 * - **With a read.** A younger blob is read (one simple operation), at most
 *   `maxReads` per pass, and deleted on the ETag it was read with if its
 *   record has expired.
 *
 * Every delete is ETag-conditional, so a blob rewritten since it was listed
 * or read is left alone. Cost per pass: one advanced operation per listed page
 * of up to `pageSize` pathnames, one simple operation per read, and free
 * deletes (each still counts against the advanced-operation rate limit).
 * Lazy expiry needs none of this for correctness — reads already treat an
 * expired record as absent — the sweep only stops dead keys from accruing
 * storage.
 */
import { EPHEMERAL_STATE_MAX_TTL_MS } from "@hobo/core";

import {
	type VercelBlobEphemeralStateOptions,
	vercelBlobInternals,
} from "./ephemeral-state.js";
import { namespacePrefix } from "./pathname.js";
import type { VercelBlobListOptions } from "./sdk.js";

export type VercelBlobPurgeOptions = VercelBlobEphemeralStateOptions & {
	/** Continue a previous pass. */
	readonly cursor?: string;
	/** Listing pages per pass. Default 1. */
	readonly maxPages?: number;
	/** Pathnames per page, at most 1,000 (the SDK's default and maximum). Default 1,000. */
	readonly pageSize?: number;
	/** Blobs read per pass to learn their expiry. Default 64. */
	readonly maxReads?: number;
	/** Longest TTL any writer of this namespace uses. Default the port's 30 days. */
	readonly maxTtlMs?: number;
	/** Allowance for writers' clocks running ahead of Blob's. Default one minute. */
	readonly clockSkewMs?: number;
};

// domain-view: number-valued view of the generated VercelBlobPurgeReport (whose int64 fields are bigint on the wire).
export type VercelBlobPurgeSummary = {
	readonly listed: number;
	readonly read: number;
	readonly deleted: number;
	/** Pass as `cursor` to continue; `undefined` once the listing is exhausted. */
	readonly cursor: string | undefined;
};

export async function purgeExpiredBlobs(
	options: VercelBlobPurgeOptions,
): Promise<VercelBlobPurgeSummary> {
	const { sdk, storeId, namespace, now, read, remove } =
		vercelBlobInternals(options);
	const store = storeId === undefined ? {} : { storeId };
	const maxPages = Math.max(1, options.maxPages ?? 1);
	const pageSize = Math.min(1_000, Math.max(1, options.pageSize ?? 1_000));
	const maxReads = Math.max(0, options.maxReads ?? 64);
	const horizonMs =
		(options.maxTtlMs ?? EPHEMERAL_STATE_MAX_TTL_MS) +
		(options.clockSkewMs ?? 60_000);
	let cursor = options.cursor;
	let listed = 0;
	let reads = 0;
	let deleted = 0;
	for (let page = 0; page < maxPages; page += 1) {
		const listOptions: VercelBlobListOptions = {
			...store,
			prefix: namespacePrefix(namespace),
			limit: pageSize,
		};
		const result = await sdk.list(
			cursor === undefined ? listOptions : { ...listOptions, cursor },
		);
		listed += result.blobs.length;
		for (const blob of result.blobs) {
			if (blob.uploadedAt.getTime() + horizonMs <= now()) {
				if (await remove(blob.pathname, blob.etag)) deleted += 1;
				continue;
			}
			if (reads >= maxReads) continue;
			reads += 1;
			const current = await read(blob.pathname);
			if (current === undefined || current.record.expiresAtMs > now()) continue;
			if (await remove(blob.pathname, current.etag)) deleted += 1;
		}
		cursor = result.hasMore ? result.cursor : undefined;
		if (cursor === undefined) break;
	}
	return { listed, read: reads, deleted, cursor };
}
