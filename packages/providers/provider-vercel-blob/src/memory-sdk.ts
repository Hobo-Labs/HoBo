/**
 * An in-memory Vercel Blob store behind the `VercelBlobSdk` subset, for tests
 * of this binding and of anything built on it.
 *
 * It enforces the semantics the binding relies on, and throws the pinned
 * SDK's own error classes so the binding's error handling is what runs:
 *
 * - every blob has an ETag, and every write gives it a new one from a single
 *   increasing counter, so an ETag is never reused, not even by a pathname
 *   that is deleted and written again;
 * - `put` with `ifMatch` applies only while the blob exists with exactly that
 *   ETag, else throws `BlobPreconditionFailedError`;
 * - `put` without `ifMatch` and without `allowOverwrite: true` on an existing
 *   pathname throws a `BlobError` saying the blob already exists (the wording
 *   is this fake's: the real message is not documented);
 * - `del` with `ifMatch` deletes only on a matching ETag, else throws
 *   `BlobPreconditionFailedError` (also when the blob is gone — undocumented
 *   for the real store, which might answer `not_found`; the binding treats
 *   both as a refusal);
 * - `get` must be an origin read (`useCache: false`): the fake models no CDN
 *   cache, so a cached read would be a binding bug it would otherwise hide;
 * - each check-and-write is atomic: nothing awaits between them.
 *
 * `delay` runs before each call reaches the store, so a test can shuffle the
 * interleaving of concurrent clients. `loseReplyWhen` models a lost reply:
 * the call is applied, then answered the way the SDK's automatic retry of
 * the same request would be answered by the store as it now is.
 */
import { BlobError, BlobPreconditionFailedError } from "@vercel/blob";

import type {
	VercelBlobGetResult,
	VercelBlobListResult,
	VercelBlobSdk,
	VercelBlobSdkMethodName,
} from "./sdk.js";

const MAX_PATHNAME = 950;
const isControl = (character: string) => {
	const code = character.charCodeAt(0);
	return code < 0x20 || code === 0x7f;
};

export type MemoryBlob = {
	readonly body: string;
	readonly etag: string;
	readonly uploadedAtMs: number;
};

export type MemoryBlobSdkOptions = {
	/** Clock for `uploadedAt`. Default `Date.now`. */
	readonly now?: () => number;
	/** Awaited before each call reaches the store. */
	readonly delay?: () => Promise<void>;
	/** True to apply this call and then answer it as a retry of it would be answered. */
	readonly loseReplyWhen?: (
		method: VercelBlobSdkMethodName,
		pathname: string,
	) => boolean;
};

export type MemoryBlobSdk = VercelBlobSdk & {
	/** The stored blobs, by pathname. */
	blobs(): ReadonlyMap<string, MemoryBlob>;
	/** Store a raw body directly, as another writer would. */
	seed(pathname: string, body: string, uploadedAtMs?: number): MemoryBlob;
};

function bodyStream(body: string): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(body);
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

function checkPathname(pathname: string): void {
	if (
		pathname.length === 0 ||
		pathname.length > MAX_PATHNAME ||
		pathname.includes("//") ||
		[...pathname].some(isControl)
	) {
		throw new BlobError("pathname is not a valid blob pathname");
	}
}

export function createMemoryBlobSdk(
	options: MemoryBlobSdkOptions = {},
): MemoryBlobSdk {
	const now = options.now ?? Date.now;
	const store = new Map<string, MemoryBlob>();
	let nextEtag = 0;
	const delay = options.delay ?? (() => Promise.resolve());
	const losesReply = options.loseReplyWhen ?? (() => false);

	function write(pathname: string, body: string): MemoryBlob {
		nextEtag += 1;
		const blob = { body, etag: `"${nextEtag}"`, uploadedAtMs: now() };
		store.set(pathname, blob);
		return blob;
	}

	function put(
		pathname: string,
		body: string,
		ifMatch: string | undefined,
		allowOverwrite: boolean,
	) {
		const existing = store.get(pathname);
		if (ifMatch !== undefined) {
			if (existing?.etag !== ifMatch) throw new BlobPreconditionFailedError();
		} else if (existing !== undefined && !allowOverwrite) {
			throw new BlobError(
				"This blob already exists, use `allowOverwrite: true` if you want to overwrite it.",
			);
		}
		return { etag: write(pathname, body).etag };
	}

	function del(pathname: string, ifMatch: string | undefined): void {
		const existing = store.get(pathname);
		if (ifMatch !== undefined && existing?.etag !== ifMatch) {
			throw new BlobPreconditionFailedError();
		}
		store.delete(pathname);
	}

	return {
		async put(pathname, body, putOptions) {
			await delay();
			checkPathname(pathname);
			if (putOptions.access !== "private" || body.length === 0) {
				throw new BlobError("a private, non-empty body is required");
			}
			const allowOverwrite =
				putOptions.ifMatch !== undefined || putOptions.allowOverwrite === true;
			const result = put(pathname, body, putOptions.ifMatch, allowOverwrite);
			if (!losesReply("put", pathname)) return result;
			return put(pathname, body, putOptions.ifMatch, allowOverwrite);
		},
		async get(pathname, getOptions): Promise<VercelBlobGetResult | null> {
			await delay();
			checkPathname(pathname);
			if (getOptions.access !== "private" || getOptions.useCache !== false) {
				throw new BlobError(
					"the fake serves origin reads of private blobs only",
				);
			}
			const blob = store.get(pathname);
			if (blob === undefined) return null;
			return {
				statusCode: 200,
				stream: bodyStream(blob.body),
				blob: { etag: blob.etag },
			};
		},
		async del(pathname, delOptions) {
			await delay();
			checkPathname(pathname);
			del(pathname, delOptions.ifMatch);
			if (losesReply("del", pathname)) del(pathname, delOptions.ifMatch);
		},
		async list(listOptions): Promise<VercelBlobListResult> {
			await delay();
			const matching = [...store.keys()]
				.filter((pathname) => pathname.startsWith(listOptions.prefix))
				.sort();
			const after = listOptions.cursor;
			const start =
				after === undefined
					? 0
					: matching.findIndex((pathname) => pathname > after);
			const page =
				start < 0 ? [] : matching.slice(start, start + listOptions.limit);
			const last = page.at(-1);
			const hasMore =
				last !== undefined && matching.indexOf(last) < matching.length - 1;
			const blobs = page.flatMap((pathname) => {
				const blob = store.get(pathname);
				return blob === undefined
					? []
					: [
							{
								pathname,
								etag: blob.etag,
								uploadedAt: new Date(blob.uploadedAtMs),
							},
						];
			});
			return hasMore && last !== undefined
				? { blobs, hasMore, cursor: last }
				: { blobs, hasMore: false };
		},
		blobs: () => new Map(store),
		seed(pathname, body, uploadedAtMs) {
			checkPathname(pathname);
			const blob = write(pathname, body);
			if (uploadedAtMs === undefined) return blob;
			const backdated = { ...blob, uploadedAtMs };
			store.set(pathname, backdated);
			return backdated;
		},
	};
}
