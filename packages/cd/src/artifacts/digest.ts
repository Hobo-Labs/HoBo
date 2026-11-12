// Digest parsing and hashing. A `Digest` exists only after `parseDigest`
// accepted it, so the store never addresses a blob by an unchecked string.
import { createHash } from "node:crypto";
import type { Digest } from "../ports.js";

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

export function parseDigest(value: string): Digest | undefined {
	// SAFETY: the pattern is exactly the `Digest` template-literal brand.
	return SHA256_DIGEST.test(value) ? (value as Digest) : undefined;
}

export function digestHex(digest: Digest): string {
	return digest.slice("sha256:".length);
}

export function sha256Digest(bytes: Uint8Array): Digest {
	// SAFETY: a sha256 hex digest prefixed with `sha256:` is a `Digest`.
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as Digest;
}

export function hashHex(
	algorithm: "sha1" | "sha256" | "sha512",
	bytes: Uint8Array,
): string {
	return createHash(algorithm).update(bytes).digest("hex");
}

export function hashBase64(
	algorithm: "sha1" | "sha256" | "sha512",
	bytes: Uint8Array,
): string {
	return createHash(algorithm).update(bytes).digest("base64");
}

const BASE64 =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Strict standard base64 (no whitespace, canonical padding); undefined when malformed. */
export function decodeBase64(text: string): Uint8Array | undefined {
	if (!BASE64.test(text)) return undefined;
	return new Uint8Array(Buffer.from(text, "base64"));
}

export function encodeBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
		"base64",
	);
}

/** Constant-time-irrelevant equality for public digests (they are not secrets). */
export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1)
		if (left[index] !== right[index]) return false;
	return true;
}
