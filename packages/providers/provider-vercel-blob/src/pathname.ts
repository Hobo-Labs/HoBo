/**
 * Where a key's blob lives: `<namespace>/<base64url(key)>`.
 *
 * Port keys are 1..512 printable ASCII characters and may hold `/`, `:`, `{`
 * and `}` (a ring's keys do). Blob pathnames treat `/` as a folder separator,
 * refuse `//`, and do not support control characters
 * (https://vercel.com/docs/vercel-blob#pathname-characters), so the key is
 * encoded rather than used verbatim. Base64url without padding is reversible,
 * uses only `A-Z a-z 0-9 - _`, and keeps the longest key at 684 characters;
 * with a namespace of at most 200 the pathname stays under the SDK's 950
 * character limit (`MAXIMUM_PATHNAME_LENGTH` in `@vercel/blob` 2.8.2).
 */
import type { EphemeralKey } from "@hobo/core";

// public-contract: pathname prefix every relay instance must share to see one cache.
export const DEFAULT_VERCEL_BLOB_NAMESPACE = "hobo-ephemeral";

const NAMESPACE = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/u;
const NAMESPACE_MAX = 200;

export type VercelBlobNamespace = string & {
	readonly __brand: "VercelBlobNamespace";
};

export function parseVercelBlobNamespace(value: string): VercelBlobNamespace {
	if (value.length > NAMESPACE_MAX || !NAMESPACE.test(value)) {
		throw new RangeError(
			`a Blob namespace is 1..${NAMESPACE_MAX} characters of lower-case letters, digits, '-' and '_', in '/'-separated segments`,
		);
	}
	// SAFETY: the brand is applied only after the pattern check above.
	return value as VercelBlobNamespace;
}

export function blobPathname(
	namespace: VercelBlobNamespace,
	key: EphemeralKey,
): string {
	// Keys are ASCII, so `btoa` (in every runtime the SDK supports) encodes them exactly.
	const base64url = btoa(key)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "");
	return `${namespace}/${base64url}`;
}

/** The listing prefix of every key blob in a namespace. */
export function namespacePrefix(namespace: VercelBlobNamespace): string {
	return `${namespace}/`;
}
