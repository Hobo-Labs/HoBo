/**
 * `IdentityAssertionVerifier` (§6.5 "Devices enroll themselves"):
 *
 * - OIDC: only pinned issuers. Each issuer's JWKS URL is configured or read
 *   once from its discovery document; keys are cached for `cacheMs` and
 *   re-read at most once a minute when a token names an unknown `kid`.
 *   RS256 and ES256 only; `iss`, `aud`, `exp`, `nbf` and `iat` are checked
 *   with 60 s of skew. Claims come back as strings (lists joined by commas).
 * - X.509: the chain (leaf first) is checked with `node:crypto`: every
 *   certificate is in its validity window, each is issued and signed by the
 *   next, every issuer is a CA, the last is issued by one of the roots, and
 *   the leaf's public key is the device's identity key. The digest is the
 *   SHA-256 of the leaf's DER.
 *
 * The assertion's single use is the enrollment's job (`tokenId`).
 */
import {
	createHash,
	createPublicKey,
	type JsonWebKey,
	type KeyObject,
	verify as verifySignature,
	X509Certificate,
} from "node:crypto";
import type { JsonObject, JsonValue } from "@hobo/core";
import type {
	Clock,
	FleetFailure,
	IdentityAssertionVerifier,
	Outcome,
} from "@hobo/fleet";
import { parsePublicJwk } from "@hobo/fleet/keys";

const SKEW_S = 60;
const DEFAULT_CACHE_MS = 60 * 60_000;
const REFETCH_FLOOR_MS = 60_000;
const MAX_ASSERTION_BYTES = 16 * 1024;

// domain-view: one configured OIDC issuer.
export type PinnedIssuer = Readonly<{
	issuer: string;
	/** Default: `jwks_uri` from `<issuer>/.well-known/openid-configuration`. */
	jwksUri?: string;
}>;

export type AssertionOptions = Readonly<{
	issuers: readonly PinnedIssuer[];
	fetch: typeof fetch;
	now: Clock;
	cacheMs?: number;
}>;

function refused<T>(message: string): Outcome<T> {
	const error: FleetFailure = { code: "unauthenticated", message };
	return { ok: false, error };
}

const tagOf = Object.prototype.toString;
function isText(value: JsonValue | undefined): value is string {
	return tagOf.call(value) === "[object String]";
}
function isCount(value: JsonValue | undefined): value is number {
	return tagOf.call(value) === "[object Number]" && Number.isFinite(value);
}
function isRecord(value: JsonValue | undefined): value is JsonObject {
	return tagOf.call(value) === "[object Object]";
}

function decode(segment: string): JsonValue | undefined {
	try {
		const parsed: JsonValue = JSON.parse(
			Buffer.from(segment, "base64url").toString("utf8"),
		);
		return parsed;
	} catch {
		return undefined;
	}
}

function claimText(value: JsonValue): string {
	if (isText(value)) return value;
	if (Array.isArray(value)) return value.map(claimText).join(",");
	if (value === null) return "";
	return isRecord(value) ? JSON.stringify(value) : String(value);
}

type CachedKeys = { keys: Map<string, KeyObject>; fetchedAtMs: number };

export function createIdentityAssertionVerifier(
	options: AssertionOptions,
): IdentityAssertionVerifier {
	const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
	const pinned = new Map(
		options.issuers.map((entry) => [entry.issuer.replace(/\/+$/u, ""), entry]),
	);
	const cache = new Map<string, CachedKeys>();

	const getJson = async (url: string): Promise<JsonValue | undefined> => {
		if (!url.startsWith("https://")) return undefined;
		const response = await options.fetch(url, {
			redirect: "error",
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) return undefined;
		const parsed: JsonValue = JSON.parse(await response.text());
		return parsed;
	};

	const jwksUriOf = async (
		entry: PinnedIssuer,
	): Promise<string | undefined> => {
		if (entry.jwksUri !== undefined) return entry.jwksUri;
		const document = await getJson(
			`${entry.issuer.replace(/\/+$/u, "")}/.well-known/openid-configuration`,
		);
		if (
			!isRecord(document) ||
			document.issuer !== entry.issuer.replace(/\/+$/u, "")
		)
			return undefined;
		return isText(document.jwks_uri) ? document.jwks_uri : undefined;
	};

	const load = async (
		issuer: string,
		entry: PinnedIssuer,
	): Promise<CachedKeys | undefined> => {
		const uri = await jwksUriOf(entry);
		if (uri === undefined) return undefined;
		const document = await getJson(uri);
		if (!isRecord(document) || !Array.isArray(document.keys)) return undefined;
		const keys = new Map<string, KeyObject>();
		for (const key of document.keys) {
			if (!isRecord(key) || !isText(key.kid)) continue;
			if (key.d !== undefined) continue; // never a private key
			try {
				// SAFETY: a JWK object from a JWKS document; createPublicKey validates it.
				keys.set(
					key.kid,
					createPublicKey({ key: key as JsonWebKey, format: "jwk" }),
				);
			} catch {
				// An unusable key is left out.
			}
		}
		const loaded = { keys, fetchedAtMs: options.now() };
		cache.set(issuer, loaded);
		return loaded;
	};

	const keyFor = async (
		issuer: string,
		entry: PinnedIssuer,
		kid: string,
	): Promise<KeyObject | undefined> => {
		let cached = cache.get(issuer);
		const age =
			cached === undefined
				? Number.POSITIVE_INFINITY
				: options.now() - cached.fetchedAtMs;
		if (
			cached === undefined ||
			age >= cacheMs ||
			(!cached.keys.has(kid) && age >= REFETCH_FLOOR_MS)
		)
			cached = (await load(issuer, entry)) ?? cached;
		return cached?.keys.get(kid);
	};

	return {
		async verifyOidc(assertion, expectedAudience) {
			if (assertion.length > MAX_ASSERTION_BYTES)
				return refused("the assertion is too large");
			const parts = assertion.split(".");
			if (parts.length !== 3)
				return refused("the assertion is not a compact JWS");
			const [head = "", body = "", signature = ""] = parts;
			const header = decode(head);
			const claims = decode(body);
			if (!isRecord(header) || !isRecord(claims))
				return refused("the assertion does not decode");
			const issuer = isText(claims.iss) ? claims.iss.replace(/\/+$/u, "") : "";
			const entry = pinned.get(issuer);
			if (entry === undefined)
				return refused("the assertion's issuer is not pinned");
			const algorithm =
				header.alg === "RS256"
					? "RSA-SHA256"
					: header.alg === "ES256"
						? "sha256"
						: undefined;
			if (algorithm === undefined || !isText(header.kid))
				return refused("the assertion's algorithm is not allowed");
			let key: KeyObject | undefined;
			try {
				key = await keyFor(issuer, entry, header.kid);
			} catch {
				return {
					ok: false,
					error: {
						code: "unavailable",
						message: "the issuer's keys could not be read",
					},
				};
			}
			if (key === undefined)
				return refused("the assertion's key is not the issuer's");
			const valid = verifySignature(
				algorithm === "sha256" ? "sha256" : "RSA-SHA256",
				Buffer.from(`${head}.${body}`),
				header.alg === "ES256" ? { key, dsaEncoding: "ieee-p1363" } : key,
				Buffer.from(signature, "base64url"),
			);
			if (!valid) return refused("the assertion's signature does not verify");
			const nowS = options.now() / 1000;
			const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
			if (!audiences.includes(expectedAudience))
				return refused("the assertion is not for this authority");
			if (!isCount(claims.exp) || claims.exp + SKEW_S <= nowS)
				return refused("the assertion has expired");
			if (isCount(claims.nbf) && claims.nbf - SKEW_S > nowS)
				return refused("the assertion is not yet valid");
			if (isCount(claims.iat) && claims.iat - SKEW_S > nowS)
				return refused("the assertion was issued in the future");
			if (!isText(claims.sub) || claims.sub.length === 0)
				return refused("the assertion has no subject");
			const strings: Record<string, string> = {};
			for (const [name, value] of Object.entries(claims))
				strings[name] = claimText(value);
			return {
				ok: true,
				value: {
					issuer,
					subject: claims.sub,
					tokenId: isText(claims.jti)
						? claims.jti
						: createHash("sha256").update(assertion).digest("base64url"),
					claims: strings,
				},
			};
		},

		verifyCertificateChain(input) {
			if (input.chainPem.length === 0) return refused("no certificate chain");
			if (input.rootsPem.length === 0)
				return refused("the fleet names no device CA roots");
			let chain: X509Certificate[];
			let roots: X509Certificate[];
			try {
				chain = input.chainPem.map((pem) => new X509Certificate(pem));
				roots = input.rootsPem.map((pem) => new X509Certificate(pem));
			} catch {
				return {
					ok: false,
					error: {
						code: "evidence-invalid",
						message: "a certificate does not parse",
					},
				};
			}
			const at = input.nowMs;
			for (const certificate of chain) {
				if (
					Date.parse(certificate.validFrom) > at ||
					Date.parse(certificate.validTo) < at
				)
					return refused("a certificate in the chain is outside its validity");
			}
			for (let index = 0; index + 1 < chain.length; index += 1) {
				const child = chain[index];
				const parent = chain[index + 1];
				if (child === undefined || parent === undefined)
					return refused("the chain is broken");
				if (
					!parent.ca ||
					!child.checkIssued(parent) ||
					!child.verify(parent.publicKey)
				)
					return refused("the chain is broken");
			}
			const last = chain.at(-1);
			const anchor = roots.find(
				(root) =>
					last !== undefined &&
					root.ca &&
					last.checkIssued(root) &&
					last.verify(root.publicKey) &&
					Date.parse(root.validTo) >= at,
			);
			if (anchor === undefined)
				return refused("the chain does not end at a trusted root");
			const leaf = chain[0];
			const identity = parsePublicJwk(input.identityJwk);
			if (leaf === undefined || !identity.ok)
				return refused("the identity key does not parse");
			const leafJwk = leaf.publicKey.export({ format: "jwk" });
			const same =
				identity.value.kty === "EC"
					? leafJwk.kty === "EC" &&
						leafJwk.crv === "P-256" &&
						leafJwk.x === identity.value.x &&
						leafJwk.y === identity.value.y
					: leafJwk.kty === "OKP" &&
						leafJwk.crv === "Ed25519" &&
						leafJwk.x === identity.value.x;
			if (!same)
				return refused("the leaf certificate is not for the identity key");
			return {
				ok: true,
				value: {
					digest: `sha256:${createHash("sha256").update(leaf.raw).digest("hex")}`,
				},
			};
		},
	};
}
