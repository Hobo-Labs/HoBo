/**
 * Secretless session material mint/verify for PAM sessions.
 * Audience-bound, short-lived, HMAC or ES256 — same discipline as JWT-SVID.
 */

import {
	createHash,
	createHmac,
	sign as cryptoSign,
	generateKeyPairSync,
	type KeyObject,
	randomBytes,
} from "node:crypto";
import type { IsolationClass } from "../env-isolation/types.js";
import { isJsonString, type JsonValue } from "../json.js";
import type { PamKind } from "./types.js";

export type SessionClaims = Readonly<{
	sid: string;
	sub: string;
	tgt: string;
	env: IsolationClass;
	kind: PamKind;
	iat: number;
	exp: number;
	jti: string;
	station: string;
}>;

function b64url(data: Buffer | string): string {
	const buf = isJsonString(data) ? Buffer.from(data, "utf8") : data;
	return buf
		.toString("base64")
		.replace(/=/g, "")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");
}

function b64urlJson(value: JsonValue): string {
	return b64url(JSON.stringify(value));
}

function decodeB64urlJson<T>(input: string): T {
	const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
	const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
	// SAFETY: assertion required at this I/O or test boundary.
	return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as T;
}

export type SessionBrokerKeys = Readonly<{
	/** HMAC secret for HS256 session tokens. */
	hmacSecret: string;
	/** Optional ES256 private key for cert-style protocols. */
	privateKey?: KeyObject;
}>;

export function createSessionBrokerKeys(input?: {
	readonly hmacSecret?: string;
	readonly useEs256?: boolean;
}): SessionBrokerKeys {
	const hmacSecret =
		input?.hmacSecret ??
		createHash("sha256").update(randomBytes(32)).digest("hex");
	if (input?.useEs256) {
		const { privateKey } = generateKeyPairSync("ec", {
			namedCurve: "P-256",
		});
		return Object.freeze({ hmacSecret, privateKey });
	}
	return Object.freeze({ hmacSecret });
}

export function mintSessionToken(input: {
	readonly claims: Omit<SessionClaims, "jti" | "iat" | "exp"> & {
		readonly ttlSeconds: number;
		readonly now?: number;
	};
	readonly keys: SessionBrokerKeys;
}) {
	const now = input.claims.now ?? Math.floor(Date.now() / 1000);
	const claims: SessionClaims = Object.freeze({
		sid: input.claims.sid,
		sub: input.claims.sub,
		tgt: input.claims.tgt,
		env: input.claims.env,
		kind: input.claims.kind,
		station: input.claims.station,
		iat: now,
		exp: now + input.claims.ttlSeconds,
		jti: randomBytes(12).toString("hex"),
	});

	if (input.keys.privateKey) {
		const header = { alg: "ES256", typ: "PAM+JWT" };
		const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
		const sig = cryptoSign("SHA256", Buffer.from(signingInput, "utf8"), {
			key: input.keys.privateKey,
			dsaEncoding: "ieee-p1363",
		});
		const token = `${signingInput}.${b64url(sig)}`;
		return {
			token,
			claims,
			credentialRef: `tokenref://pam/${claims.kind}/${claims.sid}`,
		};
	}

	const header = { alg: "HS256", typ: "PAM+JWT" };
	const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
	const sig = createHmac("sha256", input.keys.hmacSecret)
		.update(signingInput)
		.digest("base64url");
	const token = `${signingInput}.${sig}`;
	return {
		token,
		claims,
		credentialRef: `tokenref://pam/${claims.kind}/${claims.sid}`,
	};
}

export function verifySessionToken(input: {
	readonly token: string;
	readonly keys: SessionBrokerKeys;
	readonly now?: number;
	readonly expectedEnv?: IsolationClass;
	readonly expectedSubject?: string;
}):
	| { ok: true; claims: SessionClaims }
	| { ok: false; code: string; reason: string } {
	try {
		const parts = input.token.split(".");
		if (parts.length !== 3) {
			return {
				ok: false,
				code: "malformed",
				reason: "session token malformed",
			};
		}
		// SAFETY: assertion required at this I/O or test boundary.
		const [hB64, pB64, sB64] = parts as [string, string, string];
		const header = decodeB64urlJson<{ alg?: string }>(hB64);
		const claims = decodeB64urlJson<SessionClaims>(pB64);
		const now = input.now ?? Math.floor(Date.now() / 1000);
		if (claims.exp < now) {
			return { ok: false, code: "expired", reason: "session token expired" };
		}
		if (input.expectedEnv && claims.env !== input.expectedEnv) {
			return {
				ok: false,
				code: "env-mismatch",
				reason: "session env does not match gateway",
			};
		}
		if (input.expectedSubject && claims.sub !== input.expectedSubject) {
			return {
				ok: false,
				code: "subject-mismatch",
				reason: "session subject mismatch",
			};
		}
		const signingInput = `${hB64}.${pB64}`;
		if (header.alg === "HS256") {
			const expected = createHmac("sha256", input.keys.hmacSecret)
				.update(signingInput)
				.digest("base64url");
			if (expected !== sB64) {
				return {
					ok: false,
					code: "bad-signature",
					reason: "session token signature invalid",
				};
			}
			return { ok: true, claims };
		}
		return {
			ok: false,
			code: "unsupported-alg",
			reason: `unsupported session alg ${header.alg ?? "?"}`,
		};
	} catch (err) {
		return {
			ok: false,
			code: "verify-error",
			reason: err instanceof Error ? err.message : String(err),
		};
	}
}

/** Protocol-specific framing of the same secretless session material. */
export function frameSessionProtocol(
	kind: PamKind,
): "ssh-cert" | "boundary-authz" | "jumpserver-token" | "hobo-svid" {
	switch (kind) {
		case "teleport":
			return "ssh-cert";
		case "boundary":
			return "boundary-authz";
		case "jumpserver":
			return "jumpserver-token";
		default:
			return "hobo-svid";
	}
}
