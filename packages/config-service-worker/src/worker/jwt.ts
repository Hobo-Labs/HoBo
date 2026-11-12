/**
 * OIDC token verification with WebCrypto, for the three issuers the Worker
 * trusts: Vercel (the relay), GitHub Actions (the deploy workflow) and, once
 * the owner configures it, Cloudflare Access (the owner). RS256 only: all
 * three sign with it.
 *
 * Keys come from the issuer's own JWKS: through OpenID discovery (Vercel,
 * GitHub), whose `jwks_uri` must be on the issuer's host, or Access's
 * documented certs path. They are cached per isolate for ten minutes and
 * refetched at most once a minute for an unknown `kid`. Every refusal is
 * `undefined`: the caller answers 401 without saying which check failed.
 */
import { base64UrlDecode, utf8 } from "./bytes.js";
import {
	field,
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	jsonObject,
} from "./json.js";
import { LIMITS, type Parsed } from "./records.js";

export type KeySource = "openid-discovery" | "access-certs";

export type TrustedIssuer = Readonly<{
	issuer: string;
	audience: string;
	keys: KeySource;
}>;

/** Claims whose signature, issuer, audience and lifetime were checked. */
export type VerifiedClaims = Parsed<JsonObject, "VerifiedClaims">;

export type JwtVerifier = Readonly<{
	verify(
		token: string,
		trusted: TrustedIssuer,
	): Promise<VerifiedClaims | undefined>;
}>;

const SKEW_SECONDS = 60;
const CACHE_MS = 10 * 60_000;
const REFETCH_MS = 60_000;
const JWKS_BYTES = 65_536;
const SEGMENT = /^[A-Za-z0-9_-]+$/u;

type KeySet = { keys: Map<string, CryptoKey>; fetchedAt: number };

function decodeSegment(segment: string): JsonObject | undefined {
	const bytes = base64UrlDecode(segment);
	if (bytes === undefined) return undefined;
	try {
		return jsonObject(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		return undefined;
	}
}

async function boundedJson(
	send: typeof fetch,
	url: string,
): Promise<JsonObject | undefined> {
	let response: Response;
	try {
		response = await send(url, {
			headers: { accept: "application/json" },
			redirect: "manual",
		});
	} catch {
		return undefined;
	}
	if (response.status !== 200) return undefined;
	const declared = response.headers.get("content-length");
	if (declared !== null && Number(declared) > JWKS_BYTES) return undefined;
	const text = await response.text();
	return text.length > JWKS_BYTES ? undefined : jsonObject(text);
}

async function jwksUrl(
	send: typeof fetch,
	trusted: TrustedIssuer,
): Promise<string | undefined> {
	if (trusted.keys === "access-certs")
		return `${trusted.issuer}/cdn-cgi/access/certs`;
	const discovery = await boundedJson(
		send,
		`${trusted.issuer}/.well-known/openid-configuration`,
	);
	const uri = field(discovery, "jwks_uri");
	if (!isJsonString(uri) || field(discovery, "issuer") !== trusted.issuer)
		return undefined;
	let parsedUri: URL;
	try {
		parsedUri = new URL(uri);
	} catch {
		return undefined;
	}
	// The keys live on the issuer's own host, over HTTPS.
	return parsedUri.protocol === "https:" &&
		parsedUri.host === new URL(trusted.issuer).host &&
		parsedUri.username === "" &&
		parsedUri.password === ""
		? parsedUri.toString()
		: undefined;
}

async function importKeys(
	document: JsonObject | undefined,
): Promise<Map<string, CryptoKey>> {
	const keys = new Map<string, CryptoKey>();
	const list = field(document, "keys");
	if (!isJsonArray(list)) return keys;
	for (const entry of list.slice(0, 32)) {
		if (!isJsonObject(entry)) continue;
		const kid = field(entry, "kid");
		const n = field(entry, "n");
		const e = field(entry, "e");
		const alg = field(entry, "alg");
		if (
			field(entry, "kty") !== "RSA" ||
			!isJsonString(kid) ||
			!isJsonString(n) ||
			!isJsonString(e) ||
			(alg !== undefined && alg !== "RS256")
		)
			continue;
		try {
			keys.set(
				kid,
				await crypto.subtle.importKey(
					"jwk",
					{ kty: "RSA", n, e, alg: "RS256", ext: true },
					{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
					false,
					["verify"],
				),
			);
		} catch {
			// A key that does not import is not a key this Worker trusts.
		}
	}
	return keys;
}

function audienceMatches(claims: JsonObject, audience: string): boolean {
	const aud = field(claims, "aud");
	if (isJsonString(aud)) return aud === audience;
	return isJsonArray(aud) && aud.some((entry) => entry === audience);
}

function lifetimeHolds(claims: JsonObject, nowSeconds: number): boolean {
	const exp = field(claims, "exp");
	const nbf = field(claims, "nbf");
	const iat = field(claims, "iat");
	if (!isJsonNumber(exp) || exp + SKEW_SECONDS <= nowSeconds) return false;
	if (
		nbf !== undefined &&
		(!isJsonNumber(nbf) || nbf - SKEW_SECONDS > nowSeconds)
	)
		return false;
	return (
		iat === undefined || (isJsonNumber(iat) && iat - SKEW_SECONDS <= nowSeconds)
	);
}

export function createJwtVerifier(
	send: typeof fetch,
	now: () => number = Date.now,
): JwtVerifier {
	const cache = new Map<string, KeySet>();

	async function keyFor(
		trusted: TrustedIssuer,
		kid: string,
	): Promise<CryptoKey | undefined> {
		const at = now();
		const cached = cache.get(trusted.issuer);
		const fresh = cached !== undefined && at - cached.fetchedAt < CACHE_MS;
		const known = cached?.keys.get(kid);
		if (fresh && known !== undefined) return known;
		// An unknown kid refetches, but at most once a minute.
		if (cached !== undefined && fresh && at - cached.fetchedAt < REFETCH_MS)
			return undefined;
		const url = await jwksUrl(send, trusted);
		if (url === undefined) return undefined;
		const keys = await importKeys(await boundedJson(send, url));
		cache.set(trusted.issuer, { keys, fetchedAt: at });
		return keys.get(kid);
	}

	return Object.freeze({
		async verify(token, trusted) {
			if (token.length > LIMITS.tokenBytes) return undefined;
			const parts = token.split(".");
			const [headerPart, payloadPart, signaturePart] = parts;
			if (
				parts.length !== 3 ||
				headerPart === undefined ||
				payloadPart === undefined ||
				signaturePart === undefined ||
				!parts.every((part) => SEGMENT.test(part))
			)
				return undefined;
			const header = decodeSegment(headerPart);
			const claims = decodeSegment(payloadPart);
			const kid = field(header, "kid");
			const typ = field(header, "typ");
			if (
				header === undefined ||
				claims === undefined ||
				field(header, "alg") !== "RS256" ||
				!isJsonString(kid) ||
				kid.length > 256 ||
				(typ !== undefined && typ !== "JWT") ||
				field(claims, "iss") !== trusted.issuer
			)
				return undefined;
			const key = await keyFor(trusted, kid);
			const signature = base64UrlDecode(signaturePart);
			if (key === undefined || signature === undefined) return undefined;
			const valid = await crypto.subtle.verify(
				"RSASSA-PKCS1-v1_5",
				key,
				signature,
				utf8(`${headerPart}.${payloadPart}`),
			);
			if (
				!valid ||
				!audienceMatches(claims, trusted.audience) ||
				!lifetimeHolds(claims, Math.floor(now() / 1000))
			)
				return undefined;
			// SAFETY: signature, issuer, audience and lifetime were checked above.
			return Object.freeze(claims) as VerifiedClaims;
		},
	});
}
