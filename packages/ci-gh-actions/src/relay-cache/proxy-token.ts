/**
 * The sandbox proxy's session token, derived instead of stored (ADR-0179):
 * nothing in the cache maps a token to a lease, so there is no proxy table to
 * lose or leak. The token is 32 bytes, base64url (43 characters, the shape
 * the proxy quota endpoint accepts): the lease id's 16 bytes, then the first
 * 16 bytes of HMAC-SHA256 over a domain-separated lease id under a key from
 * the config service. Holding the key is what lets the relay re-derive and
 * check any token; holding a token proves nothing about any other lease.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const LEASE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTEXT = "hobo-ci:sandbox-proxy-token:v1:";

export type ProxyTokenKey = Readonly<{ bytes: Buffer }>;

/** Parse the configured key bytes; at least 32. The key is never logged. */
export function parseProxyTokenKey(raw: Uint8Array): ProxyTokenKey {
	const bytes = Buffer.from(raw);
	if (bytes.length < 32) throw new Error("sandbox proxy token key too short");
	return Object.freeze({ bytes });
}

function mac(key: ProxyTokenKey, leaseId: string): Buffer {
	return createHmac("sha256", key.bytes)
		.update(CONTEXT + leaseId)
		.digest()
		.subarray(0, 16);
}

export function deriveSandboxProxyToken(
	key: ProxyTokenKey,
	leaseId: string,
): string {
	if (!LEASE.test(leaseId)) throw new Error("invalid lease id");
	const id = Buffer.from(leaseId.replaceAll("-", ""), "hex");
	return Buffer.concat([id, mac(key, leaseId)]).toString("base64url");
}

/** The digest the proxy quota endpoint and the controller exchange. */
export function sandboxProxyTokenDigest(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/** The lease a well-formed, authentic token names; `undefined` for anything else. */
export function verifySandboxProxyToken(
	key: ProxyTokenKey,
	token: string,
): string | undefined {
	if (!TOKEN.test(token)) return undefined;
	const bytes = Buffer.from(token, "base64url");
	if (bytes.length !== 32 || bytes.toString("base64url") !== token)
		return undefined;
	const hex = bytes.subarray(0, 16).toString("hex");
	const leaseId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	return timingSafeEqual(bytes.subarray(16), mac(key, leaseId))
		? leaseId
		: undefined;
}

/** Whether a token digest is the digest of this lease's derived token. */
export function sandboxProxyDigestMatches(
	key: ProxyTokenKey,
	leaseId: string,
	digestHex: string,
): boolean {
	if (!/^[a-f0-9]{64}$/.test(digestHex) || !LEASE.test(leaseId)) return false;
	return timingSafeEqual(
		Buffer.from(
			sandboxProxyTokenDigest(deriveSandboxProxyToken(key, leaseId)),
			"hex",
		),
		Buffer.from(digestHex, "hex"),
	);
}
