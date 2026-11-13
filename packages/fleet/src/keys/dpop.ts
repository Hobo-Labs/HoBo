// DPoP proofs (RFC 9449), ported from the delivery stack's
// `packages/cd/src/agent/dpop.ts`. A member signs one proof per request; the
// verifier checks `typ`, `alg`, the embedded public `jwk`, `htm`, `htu` (no
// query or fragment), `iat` within ±60 s, `jti`, and — when an access token
// accompanies the request — `ath`. Replay of `jti` is the replay store's job
// (./dpop-verifier.ts); key binding (`cnf.jkt`) is the caller's.
//
// Adapted: proofs are signed through the `Signer` port, refusals carry the
// fleet error codes (`proof-invalid`), and the skew is fixed by the design.
import { createHash, randomBytes } from "node:crypto";
import type { JsonObject } from "@hobo/core";
import type { Outcome, PublicJwk, Signer } from "../ports.js";
import {
	algorithmOf,
	decodeCompactJws,
	jwsAlgorithmOf,
	parsePublicJwkObject,
	publicJwkJson,
	refuse,
	signCompactJws,
	thumbprintOf,
	verifyCompactJws,
} from "./jose.js";
import { isJsonNumber, isJsonObject, isJsonString } from "./json.js";

// public-contract: the DPoP proof JWT type (RFC 9449 §4.2).
export const DPOP_JWT_TYPE = "dpop+jwt";
/** `iat` must be within this much of the verifier's clock (design §11.4 L01). */
export const DPOP_SKEW_MS = 60_000;

export type VerifiedDpop = Readonly<{
	jkt: string;
	jwk: PublicJwk;
	jti: string;
	iatSeconds: number;
	htm: string;
	htu: string;
}>;

/** base64url(SHA-256(access token)), the `ath` claim. */
export function accessTokenHash(accessToken: string): string {
	return createHash("sha256").update(accessToken).digest("base64url");
}

/** `htu` normal form: scheme, host and path; query and fragment removed. */
export function normalizeHtu(url: string): string {
	const parsed = new URL(url);
	return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}

export type DpopProofInput = Readonly<{
	htm: string;
	htu: string;
	nowMs: number;
	accessToken?: string;
}>;

export async function createDpopProof(
	signer: Signer,
	publicJwk: PublicJwk,
	input: DpopProofInput,
): Promise<string> {
	if (signer.algorithm !== algorithmOf(publicJwk))
		throw new Error("the signer's algorithm does not fit the public JWK");
	const header: JsonObject = {
		typ: DPOP_JWT_TYPE,
		alg: jwsAlgorithmOf(publicJwk),
		jwk: publicJwkJson(publicJwk),
	};
	const base: JsonObject = {
		jti: randomBytes(16).toString("base64url"),
		htm: input.htm,
		htu: normalizeHtu(input.htu),
		iat: Math.floor(input.nowMs / 1000),
	};
	const payload: JsonObject =
		input.accessToken === undefined
			? base
			: { ...base, ath: accessTokenHash(input.accessToken) };
	return signCompactJws(header, payload, signer);
}

export type DpopExpectation = Readonly<{
	htm: string;
	/** Full URL, or a path when the verifier does not know its public origin. */
	htu: string;
	nowMs: number;
	accessToken?: string;
}>;

function pathOf(url: string): string | undefined {
	try {
		return new URL(url, "https://authority.invalid").pathname;
	} catch {
		return undefined;
	}
}

function hostOf(url: string): string | undefined {
	try {
		return /^https?:\/\//u.test(url) ? new URL(url).host : undefined;
	} catch {
		return undefined;
	}
}

/** Signature and claims; not replay. */
export function verifyDpopClaims(
	proof: string,
	expect: DpopExpectation,
): Outcome<VerifiedDpop> {
	const decoded = decodeCompactJws(proof);
	if (!decoded)
		return refuse("proof-invalid", "the DPoP proof is not a compact JWS");
	const { header, payload } = decoded;
	if (header.typ !== DPOP_JWT_TYPE)
		return refuse("proof-invalid", `typ must be ${DPOP_JWT_TYPE}`);
	const jwkJson = header.jwk;
	if (!isJsonObject(jwkJson))
		return refuse("proof-invalid", "the proof header has no public `jwk`");
	const jwk = parsePublicJwkObject(jwkJson);
	if (!jwk.ok) return refuse("proof-invalid", jwk.error.message);
	if (header.alg !== jwsAlgorithmOf(jwk.value))
		return refuse(
			"proof-invalid",
			`alg ${String(header.alg)} does not fit the key`,
		);
	if (!verifyCompactJws(decoded, jwk.value))
		return refuse("proof-invalid", "the DPoP proof signature does not verify");
	const { htm, htu, iat, jti, ath } = payload;
	if (
		!isJsonString(htm) ||
		!isJsonString(htu) ||
		!isJsonNumber(iat) ||
		!isJsonString(jti) ||
		jti.length === 0
	)
		return refuse("proof-invalid", "the proof lacks htm, htu, iat or jti");
	if (htm !== expect.htm)
		return refuse("proof-invalid", `htm ${htm} is not ${expect.htm}`);
	const expectedPath = pathOf(expect.htu);
	const proofPath = pathOf(htu);
	const expectedHost = hostOf(expect.htu);
	if (
		proofPath === undefined ||
		proofPath !== expectedPath ||
		/[?#]/u.test(htu) ||
		(expectedHost !== undefined && hostOf(htu) !== expectedHost)
	)
		return refuse("proof-invalid", `htu ${htu} does not match ${expect.htu}`);
	if (
		!Number.isFinite(iat) ||
		Math.abs(iat * 1000 - expect.nowMs) > DPOP_SKEW_MS
	)
		return refuse(
			"proof-invalid",
			`iat ${iat} is outside ±${DPOP_SKEW_MS} ms of the verifier clock`,
		);
	if (
		expect.accessToken !== undefined &&
		ath !== accessTokenHash(expect.accessToken)
	)
		return refuse("proof-invalid", "ath does not hash the presented token");
	return {
		ok: true,
		value: Object.freeze({
			jkt: thumbprintOf(jwk.value),
			jwk: jwk.value,
			jti,
			iatSeconds: iat,
			htm,
			htu,
		}),
	};
}
