/**
 * SPIFFE JWT-SVID mint and verify (audience-bound, short-lived).
 * Production: replace HMAC with SPIRE Workload API fetch; verification uses
 * the same claim shape (sub=spiffe id, aud, exp, iat).
 */

import {
	createHmac,
	createPrivateKey,
	createPublicKey,
	sign as cryptoSign,
	verify as cryptoVerify,
	generateKeyPairSync,
	type KeyObject,
	randomBytes,
} from "node:crypto";
import {
	cloneAsJson,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
} from "../json.js";

/** Default HMAC only allowed in development / explicit opt-in. */
export const DEFAULT_SVID_HMAC_SECRET = "hobo-local-svid-dev-only" as const;

export function resolveSvidHmacSecret(input: {
	readonly hmacSecret?: string;
	readonly env?: NodeJS.ProcessEnv;
	/** Force allow default secret (tests). */
	readonly allowDefaultSecret?: boolean;
}): string {
	const env = input.env ?? process.env;
	const provided = input.hmacSecret;
	if (provided !== undefined && provided.length > 0) {
		if (
			provided === DEFAULT_SVID_HMAC_SECRET &&
			!input.allowDefaultSecret &&
			isProductionLike(env)
		) {
			throw new Error(
				"jwt-svid: default HMAC secret is not allowed in production; pass hmacSecret resolved from the owner's store (owner://HOBO_SVID_HMAC_SECRET) or provide ES256 issuer keys",
			);
		}
		return provided;
	}
	if (input.allowDefaultSecret === true || !isProductionLike(env)) {
		return DEFAULT_SVID_HMAC_SECRET;
	}
	throw new Error(
		"jwt-svid: hmacSecret resolved from the owner's store (owner://HOBO_SVID_HMAC_SECRET), or privateKey, required outside development",
	);
}

function isProductionLike(env: NodeJS.ProcessEnv): boolean {
	const nodeEnv = (env.NODE_ENV ?? "").toLowerCase();
	const hoboEnv = (env.HOBO_ENV ?? "").toLowerCase();
	return (
		nodeEnv === "production" || hoboEnv === "prod" || hoboEnv === "production"
	);
}

export interface JwtSvidClaims {
	readonly sub: string;
	readonly aud: readonly string[];
	readonly exp: number;
	readonly iat: number;
	readonly iss?: string;
	readonly jti?: string;
}

export interface MintedJwtSvid {
	readonly token: string;
	readonly claims: JwtSvidClaims;
	readonly spiffeId: string;
}

function b64url(data: Buffer | string): string {
	const buf = isJsonString(data) ? Buffer.from(data, "utf8") : data;
	return buf
		.toString("base64")
		.replace(/=/g, "")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");
}

function isCryptoKey(value: KeyObject | JsonObject): value is KeyObject {
	return "export" in value && value.export instanceof Function;
}

function jwkFrom(value: KeyObject | JsonObject): JsonWebKey {
	if (isJsonObject(value)) {
		// SAFETY: JWK parse boundary for SPIFFE JWT-SVID issuer keys.
		return value as JsonWebKey;
	}
	return {};
}

function b64urlJson<T>(value: T): string {
	return b64url(JSON.stringify(cloneAsJson(value)));
}

function decodeB64urlJson<T>(input: string): T {
	const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
	const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
	// SAFETY: assertion required at this I/O or test boundary.
	return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as T;
}

/**
 * Mint a JWT-SVID with ES256 when a key is provided; otherwise HS256 with a
 * local trust domain secret (still audience-bound and short-lived).
 */
export function mintJwtSvid(input: {
	readonly spiffeId: string;
	readonly audience: string | readonly string[];
	readonly ttlSeconds?: number;
	readonly issuer?: string;
	readonly now?: number;
	/** HMAC secret for HS256 local trust domain. */
	readonly hmacSecret?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly allowDefaultSecret?: boolean;
	/** ES256 private key (JWK or KeyObject). */
	readonly privateKey?: KeyObject | JsonObject;
	readonly kid?: string;
}): MintedJwtSvid {
	const now = input.now ?? Math.floor(Date.now() / 1000);
	const ttl = input.ttlSeconds ?? 900;
	const aud = Array.isArray(input.audience) ? input.audience : [input.audience];
	if (!input.spiffeId.startsWith("spiffe://")) {
		throw new Error("jwt-svid: spiffeId must start with spiffe://");
	}
	const claims: JwtSvidClaims = {
		sub: input.spiffeId,
		aud,
		iat: now,
		exp: now + ttl,
		...(input.issuer !== undefined ? { iss: input.issuer } : undefined),
		jti: randomBytes(16).toString("hex"),
	};

	if (input.privateKey) {
		const privateKey = input.privateKey;
		let key: KeyObject;
		if (isCryptoKey(privateKey)) {
			key = privateKey;
		} else {
			// SAFETY: JWK object already parsed at the mint boundary.
			const keyInput = {
				format: "jwk",
				key: jwkFrom(privateKey),
			} as Parameters<typeof createPrivateKey>[0];
			key = createPrivateKey(keyInput);
		}
		const header = {
			alg: "ES256",
			typ: "JWT",
			...(input.kid !== undefined ? { kid: input.kid } : undefined),
		};
		const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
		const sig = cryptoSign("SHA256", Buffer.from(signingInput, "utf8"), {
			key,
			dsaEncoding: "ieee-p1363",
		});
		return {
			token: `${signingInput}.${b64url(sig)}`,
			claims,
			spiffeId: input.spiffeId,
		};
	}

	const secret = resolveSvidHmacSecret({
		...(input.hmacSecret !== undefined
			? { hmacSecret: input.hmacSecret }
			: undefined),
		...(input.env !== undefined ? { env: input.env } : undefined),
		...(input.allowDefaultSecret !== undefined
			? { allowDefaultSecret: input.allowDefaultSecret }
			: undefined),
	});
	const header = { alg: "HS256", typ: "JWT" };
	const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
	const sig = createHmac("sha256", secret)
		.update(signingInput)
		.digest("base64url");
	return {
		token: `${signingInput}.${sig}`,
		claims,
		spiffeId: input.spiffeId,
	};
}

export function verifyJwtSvid(input: {
	readonly token: string;
	readonly audience: string;
	readonly hmacSecret?: string;
	readonly publicKey?: KeyObject | JsonObject;
	readonly now?: number;
	readonly maxClockSkewSeconds?: number;
}): JwtSvidClaims {
	const parts = input.token.split(".");
	if (parts.length !== 3) {
		throw new Error("jwt-svid: malformed token");
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const [hB64, pB64, sB64] = parts as [string, string, string];
	const header = decodeB64urlJson<{ alg?: string }>(hB64);
	const claims = decodeB64urlJson<JwtSvidClaims>(pB64);
	const now = input.now ?? Math.floor(Date.now() / 1000);
	const skew = input.maxClockSkewSeconds ?? 60;

	if (!claims.sub?.startsWith("spiffe://")) {
		throw new Error("jwt-svid: sub must be a spiffe id");
	}
	const aud = Array.isArray(claims.aud)
		? [...claims.aud]
		: isJsonString(claims.aud)
			? [claims.aud]
			: [];
	if (!aud.includes(input.audience)) {
		throw new Error("jwt-svid: audience mismatch");
	}
	if (!isJsonNumber(claims.exp) || claims.exp + skew < now) {
		throw new Error("jwt-svid: token expired");
	}
	if (isJsonNumber(claims.iat) && claims.iat - skew > now) {
		throw new Error("jwt-svid: iat in the future");
	}

	const signingInput = `${hB64}.${pB64}`;
	if (header.alg === "ES256") {
		if (!input.publicKey) {
			throw new Error("jwt-svid: publicKey required for ES256");
		}
		const publicKey = input.publicKey;
		let key: KeyObject;
		if (isCryptoKey(publicKey)) {
			key = publicKey;
		} else {
			// SAFETY: JWK object already parsed at the verify boundary.
			const keyInput = {
				format: "jwk",
				key: jwkFrom(publicKey),
			} as Parameters<typeof createPublicKey>[0];
			key = createPublicKey(keyInput);
		}
		const pad = sB64.length % 4 === 0 ? "" : "=".repeat(4 - (sB64.length % 4));
		const sig = Buffer.from(
			sB64.replace(/-/g, "+").replace(/_/g, "/") + pad,
			"base64",
		);
		const ok = cryptoVerify(
			"SHA256",
			Buffer.from(signingInput, "utf8"),
			{ key, dsaEncoding: "ieee-p1363" },
			sig,
		);
		if (!ok) throw new Error("jwt-svid: ES256 signature invalid");
		return { ...claims, aud };
	}

	if (header.alg === "HS256") {
		// Algorithm confusion guard. The token's own header must not be able to
		// choose the verification algorithm: a caller that configured an ES256
		// public key is verifying against an asymmetric issuer, and an HS256
		// token can only have been signed with a *shared* secret.
		//
		// Without this, an attacker takes any ES256-issued token, rewrites the
		// header to HS256, and re-signs with DEFAULT_SVID_HMAC_SECRET — which is
		// an exported constant in this repository. The HS256 branch below falls
		// back to exactly that secret when no `hmacSecret` is supplied, and an
		// ES256-configured caller has no reason to supply one. The forged token
		// then verifies, for any `sub` and any `aud` the attacker chooses.
		if (input.publicKey !== undefined && input.hmacSecret === undefined) {
			throw new Error(
				"jwt-svid: algorithm mismatch — token is HS256 but verification was configured for ES256",
			);
		}
		const secret = resolveSvidHmacSecret({
			...(input.hmacSecret !== undefined
				? { hmacSecret: input.hmacSecret }
				: undefined),
			allowDefaultSecret: true,
		});
		const expected = createHmac("sha256", secret)
			.update(signingInput)
			.digest("base64url");
		if (expected !== sB64) {
			throw new Error("jwt-svid: HS256 signature invalid");
		}
		return { ...claims, aud };
	}

	throw new Error(`jwt-svid: unsupported alg ${header.alg ?? "?"}`);
}

/** Generate an ES256 key pair suitable for a local trust domain issuer. */
export function generateSvidIssuerKeys() {
	const { privateKey, publicKey } = generateKeyPairSync("ec", {
		namedCurve: "P-256",
	});
	return {
		privateKey,
		publicKey,
		// SAFETY: assertion required at this I/O or test boundary.
		publicJwk: publicKey.export({ format: "jwk" }) as JsonObject,
		// SAFETY: assertion required at this I/O or test boundary.
		privateJwk: privateKey.export({ format: "jwk" }) as JsonObject,
	};
}

export function spiffeIdForAgent(
	agentId: string,
	trustDomain = "hobo.local",
): string {
	const id = agentId.replace(/^agent:/, "").replace(/^spiffe:\/\//, "");
	if (id.startsWith(`${trustDomain}/`)) {
		return `spiffe://${id}`;
	}
	return `spiffe://${trustDomain}/agent/${encodeURIComponent(id)}`;
}
