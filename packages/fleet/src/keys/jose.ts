// Minimal JOSE for fleet keys, ported from the delivery stack's
// `packages/cd/src/agent/jose.ts` (design §8.2): parse a public JWK into a
// derived type (parse, don't validate), compute its RFC 7638 thumbprint, and
// sign/verify compact JWS with ES256 (P-256, IEEE P1363) or EdDSA (Ed25519).
// node:crypto only; no JOSE dependency. RSA keys are refused.
//
// Adapted: signing goes through the `Signer` port (the private key never
// reaches this module), JSON checks use `@hobo/core`'s JSON guards, and
// refusals are `Outcome` failures with the fleet error codes of §7.6.
import {
	createHash,
	createPublicKey,
	type JsonWebKey,
	type KeyObject,
	verify,
} from "node:crypto";
import type { JsonObject, JsonValue } from "@hobo/core";
import { KeyAlgorithm } from "../_generated/fleet_pb.js";
import type { FleetFailure, Outcome, PublicJwk, Signer } from "../ports.js";
import { isJsonObject, isJsonString } from "./json.js";

const B64URL = /^[A-Za-z0-9_-]+$/u;
const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"] as const;

export function refuse<T>(
	code: FleetFailure["code"],
	message: string,
): Outcome<T> {
	return { ok: false, error: { code, message } };
}

/** Parses JSON text without throwing; undefined when it is not JSON. */
export function jsonOf(text: string): JsonValue | undefined {
	try {
		// SAFETY: JSON.parse yields a JSON value at this document boundary.
		return JSON.parse(text) as JsonValue;
	} catch {
		return undefined;
	}
}

/** The JWK object form of a parsed key: EC P-256 or OKP Ed25519, public members only. */
export function parsePublicJwkObject(json: JsonObject): Outcome<PublicJwk> {
	for (const member of PRIVATE_MEMBERS)
		if (json[member] !== undefined)
			return refuse("invalid-request", "the JWK carries private key material");
	const x = json.x;
	if (!isJsonString(x) || !B64URL.test(x))
		return refuse("invalid-request", "the JWK has no base64url `x`");
	if (json.kty === "EC" && json.crv === "P-256") {
		const y = json.y;
		if (!isJsonString(y) || !B64URL.test(y))
			return refuse("invalid-request", "the EC JWK has no base64url `y`");
		if (!usable({ kty: "EC", crv: "P-256", x, y }))
			return refuse("invalid-request", "the EC JWK is not a P-256 point");
		return {
			ok: true,
			value: Object.freeze({ kty: "EC", crv: "P-256", x, y }),
		};
	}
	if (json.kty === "OKP" && json.crv === "Ed25519") {
		if (!usable({ kty: "OKP", crv: "Ed25519", x }))
			return refuse("invalid-request", "the OKP JWK is not an Ed25519 key");
		return {
			ok: true,
			value: Object.freeze({ kty: "OKP", crv: "Ed25519", x }),
		};
	}
	return refuse(
		"invalid-request",
		`unsupported key type ${String(json.kty)}/${String(json.crv)}`,
	);
}

function usable(jwk: PublicJwk): boolean {
	try {
		publicKeyOf(jwk);
		return true;
	} catch {
		return false;
	}
}

export function parsePublicJwkText(text: string): Outcome<PublicJwk> {
	const json = jsonOf(text);
	if (!isJsonObject(json))
		return refuse("invalid-request", "the JWK is not a JSON object");
	return parsePublicJwkObject(json);
}

/** RFC 7638 §3.2: the required members only, in lexicographic order, no whitespace. */
export function thumbprintOfMembers(
	members: ReadonlyArray<readonly [string, string]>,
): string {
	const sorted = [...members].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const canonical = `{${sorted.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(",")}}`;
	return createHash("sha256").update(canonical).digest("base64url");
}

export function thumbprintOf(jwk: PublicJwk): string {
	return jwk.kty === "EC"
		? thumbprintOfMembers([
				["crv", jwk.crv],
				["kty", jwk.kty],
				["x", jwk.x],
				["y", jwk.y],
			])
		: thumbprintOfMembers([
				["crv", jwk.crv],
				["kty", jwk.kty],
				["x", jwk.x],
			]);
}

export function algorithmOf(jwk: PublicJwk): KeyAlgorithm {
	return jwk.kty === "EC" ? KeyAlgorithm.ES256 : KeyAlgorithm.EDDSA;
}

export function jwsAlgorithmOf(jwk: PublicJwk): "ES256" | "EdDSA" {
	return jwk.kty === "EC" ? "ES256" : "EdDSA";
}

export function publicJwkJson(jwk: PublicJwk): JsonObject {
	return jwk.kty === "EC"
		? { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }
		: { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
}

export function publicKeyOf(jwk: PublicJwk): KeyObject {
	const key: JsonWebKey = { ...publicJwkJson(jwk) };
	return createPublicKey({ key, format: "jwk" });
}

/** The public JWK of a node KeyObject (public or private); private members are dropped. */
export function publicJwkOfKey(key: KeyObject): PublicJwk {
	const exported = (key.type === "public" ? key : createPublicKey(key)).export({
		format: "jwk",
	});
	const members: JsonObject = {
		kty: exported.kty ?? "",
		crv: exported.crv ?? "",
		x: exported.x ?? "",
	};
	const parsed = parsePublicJwkObject(
		exported.y === undefined ? members : { ...members, y: exported.y },
	);
	if (!parsed.ok) throw new Error(parsed.error.message);
	return parsed.value;
}

/** Verifies a raw signature over `data` with ES256 (P1363) or EdDSA, by the key's own algorithm. */
export function verifyRaw(
	jwk: PublicJwk,
	data: Uint8Array,
	signature: Uint8Array,
): boolean {
	try {
		const key = publicKeyOf(jwk);
		return jwk.kty === "EC"
			? verify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, signature)
			: verify(null, data, key, signature);
	} catch {
		return false;
	}
}

function b64urlJson(value: JsonObject): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Compact JWS over the `Signer` port; `header.alg` must name the signer's algorithm. */
export async function signCompactJws(
	header: JsonObject,
	payload: JsonObject,
	signer: Signer,
): Promise<string> {
	const input = `${b64urlJson(header)}.${b64urlJson(payload)}`;
	const signature = await signer.sign(Buffer.from(input));
	return `${input}.${Buffer.from(signature).toString("base64url")}`;
}

export type DecodedJws = Readonly<{
	header: JsonObject;
	payload: JsonObject;
	signingInput: string;
	signature: Buffer;
}>;

export function decodeCompactJws(token: string): DecodedJws | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	const [h, p, s] = parts;
	if (!h || !p || !s || !B64URL.test(h) || !B64URL.test(p) || !B64URL.test(s))
		return undefined;
	const header = jsonOf(Buffer.from(h, "base64url").toString("utf8"));
	const payload = jsonOf(Buffer.from(p, "base64url").toString("utf8"));
	if (!isJsonObject(header) || !isJsonObject(payload)) return undefined;
	return {
		header,
		payload,
		signingInput: `${h}.${p}`,
		signature: Buffer.from(s, "base64url"),
	};
}

export function verifyCompactJws(decoded: DecodedJws, jwk: PublicJwk): boolean {
	return verifyRaw(jwk, Buffer.from(decoded.signingInput), decoded.signature);
}
