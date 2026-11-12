// Minimal JOSE for agent proof-of-possession keys: parse a public JWK into a
// derived type (parse, don't validate), compute its RFC 7638 thumbprint, and
// sign/verify compact JWS with ES256 (P-256) or EdDSA (Ed25519). node:crypto
// only; no JOSE dependency. RSA agent keys are refused: DPoP keys are small,
// fast and modern by policy.
import {
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	type JsonWebKey,
	type KeyObject,
	sign,
	verify,
} from "node:crypto";
import type { JsonObject, JsonValue } from "@hobo/core";
import type { Outcome } from "../ports.js";
import { agentRefusal } from "./errors.js";

export type JwsAlgorithm = "ES256" | "EdDSA";

declare const publicJwkBrand: unique symbol;
declare const thumbprintBrand: unique symbol;

/** A parsed public JWK: one of the two accepted key shapes, never private material. */
export type PublicJwk = (
	| Readonly<{ kty: "EC"; crv: "P-256"; x: string; y: string }>
	| Readonly<{ kty: "OKP"; crv: "Ed25519"; x: string }>
) & { readonly [publicJwkBrand]: "cd.PublicJwk" };

/** RFC 7638 SHA-256 thumbprint, base64url (the `cnf.jkt` value of RFC 9449). */
export type JwkThumbprint = string & { readonly [thumbprintBrand]: "cd.JwkThumbprint" };

const B64URL = /^[A-Za-z0-9_-]+$/;

function text(value: JsonValue | undefined): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parsePublicJwk(json: JsonObject): Outcome<PublicJwk> {
	if (json.d !== undefined || json.p !== undefined || json.q !== undefined)
		return agentRefusal("jwk-invalid", "the JWK carries private key material");
	const x = text(json.x);
	if (!x || !B64URL.test(x)) return agentRefusal("jwk-invalid", "the JWK has no base64url `x`");
	if (json.kty === "EC" && json.crv === "P-256") {
		const y = text(json.y);
		if (!y || !B64URL.test(y)) return agentRefusal("jwk-invalid", "the EC JWK has no base64url `y`");
		// SAFETY: every member of the EC branch was checked above.
		return { ok: true, value: Object.freeze({ kty: "EC", crv: "P-256", x, y }) as PublicJwk };
	}
	if (json.kty === "OKP" && json.crv === "Ed25519")
		// SAFETY: every member of the OKP branch was checked above.
		return { ok: true, value: Object.freeze({ kty: "OKP", crv: "Ed25519", x }) as PublicJwk };
	return agentRefusal("jwk-invalid", `unsupported key type ${String(json.kty)}/${String(json.crv)}`);
}

export function jwkThumbprint(jwk: PublicJwk): JwkThumbprint {
	// RFC 7638 §3.2: required members only, lexicographic order, no whitespace.
	const canonical =
		jwk.kty === "EC"
			? `{"crv":"${jwk.crv}","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`
			: `{"crv":"${jwk.crv}","kty":"OKP","x":"${jwk.x}"}`;
	// SAFETY: the RFC 7638 digest of a parsed key is a thumbprint by definition.
	return createHash("sha256").update(canonical).digest("base64url") as JwkThumbprint;
}

export function algorithmOf(jwk: PublicJwk): JwsAlgorithm {
	return jwk.kty === "EC" ? "ES256" : "EdDSA";
}

export function publicJwkJson(jwk: PublicJwk): JsonObject {
	return jwk.kty === "EC" ? { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } : { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
}

function keyObject(jwk: JsonObject, kind: "public" | "private"): KeyObject {
	// SAFETY: node:crypto validates the JWK members; a malformed key throws and is refused by the caller.
	const options = { key: jwk as JsonWebKey, format: "jwk" as const };
	return kind === "public" ? createPublicKey(options) : createPrivateKey(options);
}

function b64urlJson(value: JsonObject): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function signCompactJws(header: JsonObject, payload: JsonObject, privateJwk: JsonObject): string {
	const alg = header.alg;
	const input = `${b64urlJson(header)}.${b64urlJson(payload)}`;
	const key = keyObject(privateJwk, "private");
	const signature =
		alg === "ES256"
			? sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" })
			: sign(null, Buffer.from(input), key);
	return `${input}.${signature.toString("base64url")}`;
}

export type DecodedJws = Readonly<{ header: JsonObject; payload: JsonObject; signingInput: string; signature: Buffer }>;

export function decodeCompactJws(token: string): DecodedJws | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	const [h, p, s] = parts;
	if (!h || !p || !s || !B64URL.test(h) || !B64URL.test(p) || !B64URL.test(s)) return undefined;
	try {
		const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
		const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
		if (!isObject(header) || !isObject(payload)) return undefined;
		return { header, payload, signingInput: `${h}.${p}`, signature: Buffer.from(s, "base64url") };
	} catch {
		return undefined;
	}
}

export function verifyCompactJws(decoded: DecodedJws, jwk: PublicJwk): boolean {
	try {
		const key = keyObject(publicJwkJson(jwk), "public");
		const data = Buffer.from(decoded.signingInput);
		return algorithmOf(jwk) === "ES256"
			? verify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, decoded.signature)
			: verify(null, data, key, decoded.signature);
	} catch {
		return false;
	}
}

export type AgentKeyPair = Readonly<{ privateJwk: JsonObject; publicJwk: JsonObject; thumbprint: JwkThumbprint }>;

/** Generate an agent key pair (used by `hobo deploy agent run` and tests). The private JWK never leaves the agent. */
export function generateAgentKey(alg: JwsAlgorithm = "ES256"): AgentKeyPair {
	const pair =
		alg === "ES256" ? generateKeyPairSync("ec", { namedCurve: "P-256" }) : generateKeyPairSync("ed25519");
	// SAFETY: node exports a JWK as a plain JSON object.
	const privateJwk = pair.privateKey.export({ format: "jwk" }) as JsonObject;
	// SAFETY: node exports a JWK as a plain JSON object.
	const publicJwk = pair.publicKey.export({ format: "jwk" }) as JsonObject;
	const parsed = parsePublicJwk(publicJwk);
	if (!parsed.ok) throw new Error("generated key did not parse");
	return Object.freeze({ privateJwk, publicJwk, thumbprint: jwkThumbprint(parsed.value) });
}

/** The public half of a private JWK (agent side). */
export function publicOf(privateJwk: JsonObject): Outcome<PublicJwk> {
	const { d: _d, ...rest } = privateJwk;
	return parsePublicJwk(rest);
}

function isObject(value: JsonValue): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
