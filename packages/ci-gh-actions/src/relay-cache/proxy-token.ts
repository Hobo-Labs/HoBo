import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const LEASE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTEXT = "hobo-ci:sandbox-proxy-token:v1:";

export type ProxyTokenKey = Readonly<{ bytes: Buffer }>;

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

export function sandboxProxyTokenDigest(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

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
