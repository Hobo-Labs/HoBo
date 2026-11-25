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
	return value as VercelBlobNamespace;
}

export function blobPathname(
	namespace: VercelBlobNamespace,
	key: EphemeralKey,
): string {
	const base64url = btoa(key)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "");
	return `${namespace}/${base64url}`;
}

export function namespacePrefix(namespace: VercelBlobNamespace): string {
	return `${namespace}/`;
}
