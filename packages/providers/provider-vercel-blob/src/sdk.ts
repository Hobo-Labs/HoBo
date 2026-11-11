/**
 * The part of `@vercel/blob` the binding calls, as a structural type, so a
 * test injects an in-memory store (`createMemoryBlobSdk`) or a recording one
 * in place of the network, and the real SDK is checked against the same type
 * (`vercelBlobSdk` below must satisfy it, or this file does not compile).
 *
 * Pinned to `@vercel/blob` 2.8.2 (published 2026-10-14). What the binding
 * relies on, read from that version's `dist/index.d.ts` and `dist/index.js`:
 *
 * - `put(pathname, body, { access: "private", allowOverwrite: false })` fails
 *   when the pathname exists; `put(..., { ifMatch })` sends `x-if-match` and
 *   implies `allowOverwrite`, and a mismatch throws
 *   `BlobPreconditionFailedError` (API error code `precondition_failed`).
 * - `get(pathname, { access: "private", useCache: false })` adds `?cache=0`
 *   and reads from origin storage; it resolves `null` on 404 and returns the
 *   blob's `etag`.
 * - `del(pathname, { ifMatch })` deletes only when the ETag matches.
 * - `list({ prefix, limit, cursor })` pages pathnames with `etag` and
 *   `uploadedAt`.
 *
 * Every call takes the store explicitly (`storeId`) and lets the SDK resolve
 * the credential itself: on Vercel that is the deployment's OIDC token, which
 * the SDK refreshes. The binding never reads, passes or logs a token.
 */
import {
	BlobAccessError,
	BlobError,
	BlobNotFoundError,
	BlobPreconditionFailedError,
	BlobServiceNotAvailable,
	BlobServiceRateLimited,
	BlobStoreNotFoundError,
	BlobStoreSuspendedError,
	BlobUnknownError,
	del,
	get,
	list,
	put,
} from "@vercel/blob";

/** Options common to every call: which store. The credential is the SDK's to find. */
export type VercelBlobStoreOptions = {
	readonly storeId?: string;
};

export type VercelBlobPutOptions = VercelBlobStoreOptions & {
	readonly access: "private";
	readonly contentType: string;
	readonly addRandomSuffix: false;
	readonly cacheControlMaxAge?: number;
	readonly allowOverwrite?: boolean;
	readonly ifMatch?: string;
};

export type VercelBlobGetOptions = VercelBlobStoreOptions & {
	readonly access: "private";
	readonly useCache: false;
};

export type VercelBlobGetResult =
	| {
			readonly statusCode: 200;
			readonly stream: ReadableStream<Uint8Array>;
			readonly blob: { readonly etag: string };
	  }
	| {
			readonly statusCode: 304;
			readonly stream: null;
			readonly blob: { readonly etag: string };
	  };

export type VercelBlobDelOptions = VercelBlobStoreOptions & {
	readonly ifMatch?: string;
};

export type VercelBlobListOptions = VercelBlobStoreOptions & {
	readonly prefix: string;
	readonly limit: number;
	readonly cursor?: string;
};

export type VercelBlobListResult = {
	readonly blobs: readonly {
		readonly pathname: string;
		readonly etag: string;
		readonly uploadedAt: Date;
	}[];
	readonly cursor?: string;
	readonly hasMore: boolean;
};

export type VercelBlobSdk = {
	put(
		pathname: string,
		body: string,
		options: VercelBlobPutOptions,
	): Promise<{ readonly etag: string }>;
	get(
		pathname: string,
		options: VercelBlobGetOptions,
	): Promise<VercelBlobGetResult | null>;
	del(pathname: string, options: VercelBlobDelOptions): Promise<void>;
	list(options: VercelBlobListOptions): Promise<VercelBlobListResult>;
};

export type VercelBlobSdkMethodName = keyof VercelBlobSdk;

/** The real SDK functions, typed as the subset the binding uses. */
export const vercelBlobSdk: VercelBlobSdk = { put, get, del, list };

/**
 * Why a write did not apply, or `undefined` when the error is not a refusal
 * and must propagate.
 *
 * `precondition-failed` is exact: `BlobPreconditionFailedError` is what the
 * SDK throws for the API's `precondition_failed` code. `refused` covers a
 * create-only `put` on an existing pathname, whose error the SDK does not
 * name: the docs say only that it "fails with an error". It is recognised by
 * the message ("already exists", or the `allowOverwrite` hint), and an
 * unclassified `BlobUnknownError` is also treated as a refusal — never as a
 * success: the binding reads the blob after every refusal and decides from
 * what is stored, so a misclassified failure costs a read and a retry, not a
 * wrong answer.
 */
export type VercelBlobRefusal = "precondition-failed" | "refused";

const NEVER_A_REFUSAL = [
	BlobAccessError,
	BlobStoreNotFoundError,
	BlobStoreSuspendedError,
	BlobServiceRateLimited,
	BlobServiceNotAvailable,
];

export function classifyBlobWriteError(
	error: Error,
): VercelBlobRefusal | undefined {
	if (error instanceof BlobPreconditionFailedError)
		return "precondition-failed";
	if (!(error instanceof BlobError)) return undefined;
	if (NEVER_A_REFUSAL.some((kind) => error instanceof kind)) return undefined;
	if (/already exists|allowOverwrite/iu.test(error.message)) return "refused";
	if (error instanceof BlobUnknownError) return "refused";
	return undefined;
}

/** A refused conditional delete: the ETag no longer matches, or the blob is gone. */
export function isBlobDeleteRefusal(error: Error): boolean {
	return (
		error instanceof BlobPreconditionFailedError ||
		error instanceof BlobNotFoundError
	);
}
