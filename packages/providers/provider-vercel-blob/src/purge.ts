import { EPHEMERAL_STATE_MAX_TTL_MS } from "@hobo/core";

import {
	type VercelBlobEphemeralStateOptions,
	vercelBlobInternals,
} from "./ephemeral-state.js";
import { namespacePrefix } from "./pathname.js";
import type { VercelBlobListOptions } from "./sdk.js";

export type VercelBlobPurgeOptions = VercelBlobEphemeralStateOptions & {
	readonly cursor?: string;
	readonly maxPages?: number;
	readonly pageSize?: number;
	readonly maxReads?: number;
	readonly maxTtlMs?: number;
	readonly clockSkewMs?: number;
};

// domain-view: number-valued view of the generated VercelBlobPurgeReport (whose int64 fields are bigint on the wire).
export type VercelBlobPurgeSummary = {
	readonly listed: number;
	readonly read: number;
	readonly deleted: number;
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
