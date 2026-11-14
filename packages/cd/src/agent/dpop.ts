// DPoP proofs (RFC 9449). The agent signs one proof per request with its
// enrolled key; the Station verifies `typ`, `alg`, the embedded public `jwk`,
// `htm`, `htu` (no query or fragment), `iat` within the allowed skew, `jti`,
// and — when an SVID accompanies the request — `ath`. Replay of `jti` is the
// replay store's job (./replay.ts); key binding (`cnf.jkt`) is the caller's.
import { createHash } from "node:crypto";
import type { JsonObject } from "@hobo/core";
import { isNumber, isText, isWireObject } from "../feed/json.js";
import type { Outcome } from "../ports.js";
import { agentRefusal } from "./errors.js";
import {
	algorithmOf,
	decodeCompactJws,
	type JwkThumbprint,
	jwkThumbprint,
	parsePublicJwk,
	publicJwkJson,
	publicOf,
	signCompactJws,
	verifyCompactJws,
} from "./jose.js";

// public-contract: the DPoP proof JWT type (RFC 9449 §4.2).
export const DPOP_JWT_TYPE = "dpop+jwt" as const;

declare const verifiedDpopBrand: unique symbol;

export type VerifiedDpop = Readonly<{
	jkt: JwkThumbprint;
	jti: string;
	iatSeconds: number;
	htm: string;
	htu: string;
}> & { readonly [verifiedDpopBrand]: "cd.VerifiedDpop" };

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
	privateJwk: JsonObject;
	method: string;
	url: string;
	iatSeconds: number;
	jti: string;
	accessToken?: string;
}>;

/** RFC 9449 §4.2 proof claims. */
export type DpopClaims = Readonly<{
	htm: string;
	htu: string;
	iat: number;
	jti: string;
	ath?: string;
}>;

export function createDpopProof(input: DpopProofInput): string {
	const pub = publicOf(input.privateJwk);
	if (!pub.ok) throw new Error(pub.reasons[0]?.message ?? "invalid agent key");
	const header: JsonObject = {
		typ: DPOP_JWT_TYPE,
		alg: algorithmOf(pub.value),
		jwk: publicJwkJson(pub.value),
	};
	const base = {
		htm: input.method,
		htu: normalizeHtu(input.url),
		iat: input.iatSeconds,
		jti: input.jti,
	};
	const payload: DpopClaims =
		input.accessToken === undefined
			? base
			: { ...base, ath: accessTokenHash(input.accessToken) };
	return signCompactJws(header, payload, input.privateJwk);
}

export type DpopExpectation = Readonly<{
	method: string;
	/** Full URL, or a path when the Station does not know its public origin. */
	url: string;
	nowMs: number;
	skewMs: number;
	accessToken?: string;
}>;

function pathOf(url: string): string | undefined {
	try {
		return new URL(url, "https://station.invalid").pathname;
	} catch {
		return undefined;
	}
}

function hostOf(url: string): string | undefined {
	return /^https?:\/\//u.test(url) ? new URL(url).host : undefined;
}

export function verifyDpopProof(
	proof: string,
	expect: DpopExpectation,
): Outcome<VerifiedDpop> {
	const decoded = decodeCompactJws(proof);
	if (!decoded)
		return agentRefusal("dpop-invalid", "the DPoP proof is not a compact JWS");
	const { header, payload } = decoded;
	if (header.typ !== DPOP_JWT_TYPE)
		return agentRefusal("dpop-invalid", `typ must be ${DPOP_JWT_TYPE}`);
	const jwkJson = header.jwk;
	if (!isWireObject(jwkJson))
		return agentRefusal("dpop-invalid", "the proof header has no public `jwk`");
	const jwk = parsePublicJwk(jwkJson);
	if (!jwk.ok)
		return agentRefusal(
			"dpop-invalid",
			jwk.reasons[0]?.message ?? "invalid proof jwk",
		);
	if (header.alg !== algorithmOf(jwk.value))
		return agentRefusal(
			"dpop-invalid",
			`alg ${String(header.alg)} does not fit the key`,
		);
	if (!verifyCompactJws(decoded, jwk.value))
		return agentRefusal(
			"dpop-invalid",
			"the DPoP proof signature does not verify",
		);
	const { htm, htu, iat, jti, ath } = payload;
	if (
		!isText(htm) ||
		!isText(htu) ||
		!isNumber(iat) ||
		!isText(jti) ||
		jti.length === 0
	)
		return agentRefusal("dpop-invalid", "the proof lacks htm, htu, iat or jti");
	if (htm !== expect.method)
		return agentRefusal(
			"dpop-method-mismatch",
			`htm ${htm} is not ${expect.method}`,
		);
	const expectedPath = pathOf(expect.url);
	const proofPath = pathOf(htu);
	const expectedHost = hostOf(expect.url);
	if (
		proofPath === undefined ||
		proofPath !== expectedPath ||
		/[?#]/u.test(htu) ||
		(expectedHost !== undefined && hostOf(htu) !== expectedHost)
	)
		return agentRefusal(
			"dpop-url-mismatch",
			`htu ${htu} does not match ${expect.url}`,
		);
	if (Math.abs(iat * 1000 - expect.nowMs) > expect.skewMs)
		return agentRefusal(
			"dpop-stale",
			`iat ${iat} is outside ±${expect.skewMs} ms of the Station clock`,
		);
	if (
		expect.accessToken !== undefined &&
		ath !== accessTokenHash(expect.accessToken)
	)
		return agentRefusal(
			"dpop-ath-mismatch",
			"ath does not hash the presented SVID",
		);
	// SAFETY: every member was verified above, including the signature.
	const value = Object.freeze({
		jkt: jwkThumbprint(jwk.value),
		jti,
		iatSeconds: iat,
		htm,
		htu,
	}) as VerifiedDpop;
	return { ok: true, value };
}
