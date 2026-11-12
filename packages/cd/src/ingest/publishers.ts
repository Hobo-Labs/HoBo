// createTrustedPublisherVerifier (WP1, D3): OIDC trusted publishing from any
// CI. A TrustedPublisherRecord pins an issuer, an audience, exact-match claims
// and the Bindles the publisher may record Freight for. A token is accepted
// only when its signature verifies against the issuer's JWKS (fetched through
// OIDC discovery over the injected HttpTransport and checked with
// @hobo/identity `verifyJwtWithJwks`), its time claims hold within the
// injected clock skew, its audience is the publisher's, and every required
// claim is equal. The result is a workload principal; nothing else is trusted.

import type { JsonObject } from "@bufbuild/protobuf";
import { create, equals } from "@bufbuild/protobuf";
import type {
	EventPosition,
	HttpTransport,
	PrincipalRef,
	ReadAllOptions,
} from "@hobo/core";
import { verifyJwtWithJwks } from "@hobo/identity";
import {
	type TrustedPublisherRecord,
	TrustedPublisherRecordSchema,
} from "../_generated/cd_pb.js";
import { CD_DEFAULTS, CD_EVENTS, CD_STREAMS } from "../events.js";
import {
	body,
	decode,
	emitCounter,
	principalName,
} from "../freight/journal.js";
import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	parseJsonText,
	stringAt,
} from "../freight/json.js";
import { reason } from "../freight/reasons.js";
import type {
	CdAuthorizer,
	CdBase,
	Outcome,
	Refusal,
	TelemetrySink,
	TrustedPublisherVerifier,
	VerifiedPublisher,
} from "../ports.js";
import { INGEST_METRIC, INGEST_REASON } from "./reasons.js";

export type TrustedPublisherVerifierDeps = CdBase & {
	readonly http: HttpTransport;
	/** Governs `trust`; without it trusting a publisher fails closed. */
	readonly authorizer?: CdAuthorizer;
	readonly telemetry?: TelemetrySink;
	/** Allowed clock skew for `exp`/`nbf`. Defaults to CD_DEFAULTS.dpopSkewMs (60 s). */
	readonly clockSkewMs?: number;
};

const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const BINDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const MAX_TOKEN_BYTES = 16_384;
const MAX_DOCUMENT_BYTES = 1_048_576;
const MAX_CACHE_MS = 86_400_000;

function refuse(
	code: string,
	message: string,
	remediation: string,
	subject = "",
): Refusal {
	return { ok: false, reasons: [reason(code, message, remediation, subject)] };
}

function httpsUrl(value: string): URL | undefined {
	try {
		const url = new URL(value);
		if (
			url.protocol !== "https:" ||
			url.username !== "" ||
			url.password !== "" ||
			url.search !== "" ||
			url.hash !== ""
		) {
			return undefined;
		}
		return url;
	} catch {
		return undefined;
	}
}

/** Parse a publisher record; refuse anything that would trust more than it names. */
export function parseTrustedPublisher(
	record: TrustedPublisherRecord,
): Outcome<TrustedPublisherRecord> {
	const problems: string[] = [];
	if (!NAME_PATTERN.test(record.name))
		problems.push("name must be a lowercase slug");
	if (!httpsUrl(record.issuer) || record.issuer.endsWith("/"))
		problems.push(
			"issuer must be an https URL without query, fragment or trailing slash",
		);
	if (record.audience.trim() === "") problems.push("audience is required");
	const claims = Object.entries(record.requiredClaims);
	if (claims.length === 0)
		problems.push(
			"at least one required claim (e.g. repository) is needed, or any repository on the issuer could publish",
		);
	if (claims.some(([key, value]) => key.trim() === "" || value.trim() === ""))
		problems.push("required claims need non-empty names and values");
	if (record.bindles.length === 0)
		problems.push("at least one Bindle is required");
	if (record.bindles.some((bindle) => !BINDLE_PATTERN.test(bindle)))
		problems.push("bindles must be Bindle ids");
	if (problems.length > 0) {
		return {
			ok: false,
			reasons: problems.map((problem) =>
				reason(
					INGEST_REASON.publisherRecordInvalid,
					problem,
					"fix the TrustedPublisherRecord and trust it again",
					record.name,
				),
			),
		};
	}
	return { ok: true, value: record };
}

type CacheEntry = Readonly<{ expiresAtMs: number; json: JsonObject }>;

/** Seconds of `max-age`, or undefined when the response must not be cached. */
export function cacheLifetimeMs(
	cacheControl: string | undefined,
): number | undefined {
	if (!cacheControl) return undefined;
	const directives = cacheControl
		.toLowerCase()
		.split(",")
		.map((part) => part.trim());
	if (
		directives.some(
			(directive) => directive === "no-store" || directive === "no-cache",
		)
	)
		return undefined;
	const maxAge = directives.find((directive) =>
		directive.startsWith("max-age="),
	);
	if (!maxAge) return undefined;
	const seconds = Number(maxAge.slice("max-age=".length));
	if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
	return Math.min(seconds * 1000, MAX_CACHE_MS);
}

function header(
	headers: Readonly<Record<string, string>>,
	name: string,
): string | undefined {
	const match = Object.entries(headers).find(
		([key]) => key.toLowerCase() === name,
	);
	return match?.[1];
}

type Decoded = Readonly<{ header: JsonObject; claims: JsonObject }>;

function decodeSegments(token: string): Decoded | undefined {
	if (token.length > MAX_TOKEN_BYTES) return undefined;
	const parts = token.split(".");
	if (parts.length !== 3 || parts.some((part) => part === "")) return undefined;
	try {
		const head = parseJsonText(
			Buffer.from(parts[0] ?? "", "base64url").toString("utf8"),
		);
		const claims = parseJsonText(
			Buffer.from(parts[1] ?? "", "base64url").toString("utf8"),
		);
		return isJsonObject(head) && isJsonObject(claims)
			? { header: head, claims }
			: undefined;
	} catch {
		return undefined;
	}
}

function audiences(claims: JsonObject): readonly string[] {
	const aud = claims.aud;
	if (isJsonString(aud)) return [aud];
	if (isJsonArray(aud)) return aud.filter(isJsonString);
	return [];
}

export function createTrustedPublisherVerifier(
	deps: TrustedPublisherVerifierDeps,
): TrustedPublisherVerifier {
	const skewMs = deps.clockSkewMs ?? CD_DEFAULTS.dpopSkewMs;
	const publishers = new Map<string, TrustedPublisherRecord>();
	let indexedTo: EventPosition | undefined;
	const cache = new Map<string, CacheEntry>();

	function emit(
		name: string,
		attributes: Readonly<Record<string, string>>,
	): void {
		emitCounter(deps.telemetry, {
			name,
			unit: "{token}",
			atMs: deps.now(),
			attributes: { tenant: deps.tenant, ...attributes },
		});
	}

	function refused(outcome: Refusal): Refusal {
		emit(INGEST_METRIC.publisherRefused, {
			code: outcome.reasons[0]?.code ?? "",
		});
		return outcome;
	}

	async function catchUp(): Promise<void> {
		const options: ReadAllOptions = {
			tenant: deps.tenant,
			filter: { type: CD_EVENTS.PublisherTrusted },
		};
		for await (const entry of deps.store.readAll(
			indexedTo === undefined ? options : { ...options, after: indexedTo },
		)) {
			indexedTo = entry.position;
			const record = decode(TrustedPublisherRecordSchema, entry.event.data);
			if (record && parseTrustedPublisher(record).ok)
				publishers.set(record.name, record);
		}
	}

	async function fetchJson(
		url: string,
		fresh: boolean,
	): Promise<JsonObject | undefined> {
		const nowMs = deps.now();
		const cached = cache.get(url);
		if (!fresh && cached && cached.expiresAtMs > nowMs) return cached.json;
		emit(INGEST_METRIC.oidcFetch, { url });
		const response = await deps.http({
			method: "GET",
			url,
			headers: { accept: "application/json" },
			timeoutMs: CD_DEFAULTS.probeTimeoutMs,
			maxResponseBytes: MAX_DOCUMENT_BYTES,
		});
		if (response.status !== 200) return undefined;
		const document = parseJsonText(response.body);
		if (!isJsonObject(document)) return undefined;
		const lifetime = cacheLifetimeMs(header(response.headers, "cache-control"));
		if (lifetime !== undefined)
			cache.set(url, { expiresAtMs: nowMs + lifetime, json: document });
		else cache.delete(url);
		return document;
	}

	async function jwksFor(
		issuer: string,
		fresh: boolean,
	): Promise<Outcome<Readonly<{ keys: JsonObject[] }>>> {
		const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
		let discovery: JsonObject | undefined;
		let jwks: JsonObject | undefined;
		try {
			discovery = await fetchJson(discoveryUrl, false);
			const jwksUri = stringAt(discovery, "jwks_uri") ?? "";
			if (discovery?.issuer !== issuer || !httpsUrl(jwksUri)) {
				return refuse(
					INGEST_REASON.publisherDiscovery,
					`OIDC discovery for ${issuer} is missing or names another issuer`,
					"check the issuer URL and that its /.well-known/openid-configuration is reachable",
					issuer,
				);
			}
			jwks = await fetchJson(jwksUri, fresh);
		} catch (error) {
			return refuse(
				INGEST_REASON.publisherDiscovery,
				`OIDC fetch for ${issuer} failed: ${error instanceof Error ? error.message : String(error)}`,
				"retry; check egress to the issuer",
				issuer,
			);
		}
		const listed = jwks?.keys;
		const keys = isJsonArray(listed) ? listed.filter(isJsonObject) : undefined;
		if (!keys) {
			return refuse(
				INGEST_REASON.publisherDiscovery,
				`JWKS for ${issuer} is unreadable`,
				"retry; check the issuer's jwks_uri",
				issuer,
			);
		}
		return { ok: true, value: { keys } };
	}

	return {
		async trust(record, ctx) {
			const parsed = parseTrustedPublisher(record);
			if (!parsed.ok) return refused(parsed);
			if (!deps.authorizer) {
				return refused(
					refuse(
						INGEST_REASON.ungoverned,
						"publisher.trust needs a policy decision and the verifier has no authorizer",
						"compose createTrustedPublisherVerifier with the CdAuthorizer (WP18 compose)",
						record.name,
					),
				);
			}
			const decision = await deps.authorizer.authorize(
				"publisher.trust",
				{
					name: record.name,
					issuer: record.issuer,
					audience: record.audience,
					bindles: [...record.bindles],
				},
				ctx,
			);
			if (!decision.ok) {
				return refused({
					ok: false,
					reasons: [
						reason(
							INGEST_REASON.unauthorized,
							"publisher.trust was denied by policy",
							"request the grant",
							record.name,
						),
						...decision.reasons,
					],
				});
			}
			if (decision.value.proposalOnly) {
				return refused(
					refuse(
						INGEST_REASON.proposalOnly,
						`${principalName(ctx.principal)} may only propose publisher.trust`,
						"ask a granted principal",
						record.name,
					),
				);
			}
			const stream = CD_STREAMS.publisher(record.name);
			let seq = 0;
			let current: TrustedPublisherRecord | undefined;
			for await (const event of deps.store.read(stream)) {
				seq = event.seq;
				if (event.type === CD_EVENTS.PublisherTrusted)
					current = decode(TrustedPublisherRecordSchema, event.data);
			}
			const normalized = create(TrustedPublisherRecordSchema, {
				...record,
				bindles: [...record.bindles].sort(),
			});
			if (current && equals(TrustedPublisherRecordSchema, current, normalized))
				return { ok: true, value: current };
			await deps.store.append(
				stream,
				[
					{
						type: CD_EVENTS.PublisherTrusted,
						data: body(TrustedPublisherRecordSchema, normalized),
					},
				],
				{
					expectedSeq: seq,
					actor: ctx.principal,
					tenant: deps.tenant,
				},
			);
			publishers.set(normalized.name, normalized);
			return { ok: true, value: normalized };
		},

		async verify(token, ctx) {
			const decoded = decodeSegments(token);
			if (!decoded) {
				return refused(
					refuse(
						INGEST_REASON.publisherToken,
						"token is not a compact JWT",
						"send the CI's OIDC ID token unchanged",
					),
				);
			}
			const { claims } = decoded;
			const issuer = stringAt(claims, "iss") ?? "";
			await catchUp();
			const candidates = [...publishers.values()]
				.filter((publisher) => publisher.issuer === issuer)
				.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
			if (candidates.length === 0) {
				return refused(
					refuse(
						INGEST_REASON.publisherIssuer,
						`no trusted publisher for issuer ${issuer || "(none)"}`,
						"trust a publisher for this issuer first",
						issuer,
					),
				);
			}
			if (
				decoded.header.alg !== "RS256" ||
				stringAt(decoded.header, "kid") === undefined
			) {
				return refused(
					refuse(
						INGEST_REASON.publisherToken,
						"token must be RS256 with a kid",
						"use the issuer's standard ID token",
						issuer,
					),
				);
			}
			const exp = claims.exp;
			const nbf = claims.nbf;
			if (!isJsonNumber(exp) || !isJsonNumber(nbf) || nbf >= exp) {
				return refused(
					refuse(
						INGEST_REASON.publisherToken,
						"token needs numeric nbf < exp",
						"use the issuer's standard ID token",
						issuer,
					),
				);
			}
			const nowSeconds = ctx.now() / 1000;
			const skewSeconds = skewMs / 1000;
			if (exp <= nowSeconds - skewSeconds || nbf > nowSeconds + skewSeconds) {
				return refused(
					refuse(
						INGEST_REASON.publisherExpired,
						"token is expired or not yet valid",
						"mint a fresh token in the CI job and retry",
						issuer,
					),
				);
			}
			const tokenAudiences = audiences(claims);
			const audienceMatches = candidates.filter((publisher) =>
				tokenAudiences.includes(publisher.audience),
			);
			const first = audienceMatches[0];
			if (!first) {
				return refused(
					refuse(
						INGEST_REASON.publisherAudience,
						"token audience matches no trusted publisher for this issuer",
						"request the token with the configured audience",
						issuer,
					),
				);
			}
			// Signature authority is @hobo/identity. Time policy (with skew) was
			// applied above; the instant passed here is the clock clamped into
			// [nbf, exp) so the library's strict checks agree with it.
			const verifyAt = Math.min(Math.max(nowSeconds, nbf), exp - 0.001);
			let verified = false;
			for (const fresh of [false, true]) {
				const jwks = await jwksFor(issuer, fresh);
				if (!jwks.ok) return refused(jwks);
				if (
					!fresh &&
					!jwks.value.keys.some((key) => key.kid === decoded.header.kid)
				)
					continue;
				try {
					await verifyJwtWithJwks(token, jwks.value, {
						issuer,
						audience: first.audience,
						now: verifyAt,
					});
					verified = true;
				} catch {
					verified = false;
				}
				break;
			}
			if (!verified) {
				return refused(
					refuse(
						INGEST_REASON.publisherToken,
						"token signature does not verify against the issuer JWKS",
						"send the CI's OIDC ID token unchanged",
						issuer,
					),
				);
			}
			const mismatches: string[] = [];
			for (const publisher of audienceMatches) {
				const missing = Object.entries(publisher.requiredClaims)
					.filter(([key, value]) => claims[key] !== value)
					.map(([key]) => key)
					.sort();
				if (missing.length === 0) {
					const subject = stringAt(claims, "sub") ?? "";
					const principal: PrincipalRef = {
						kind: "service",
						id: `workload:${publisher.name}:${subject}`,
					};
					emit(INGEST_METRIC.publisherVerified, { publisher: publisher.name });
					const value: VerifiedPublisher = {
						principal,
						publisher: publisher.name,
						claims,
					};
					return { ok: true, value };
				}
				mismatches.push(`${publisher.name}: ${missing.join(", ")}`);
			}
			return refused(
				refuse(
					INGEST_REASON.publisherClaims,
					`required claims missing or different (${mismatches.join("; ")})`,
					"run the publish from the configured repository, workflow and environment",
					issuer,
				),
			);
		},
	};
}

/** The publisher records currently trusted, read from the journal (latest per name). */
export async function readTrustedPublishers(
	deps: CdBase,
): Promise<ReadonlyMap<string, TrustedPublisherRecord>> {
	const out = new Map<string, TrustedPublisherRecord>();
	for await (const entry of deps.store.readAll({
		tenant: deps.tenant,
		filter: { type: CD_EVENTS.PublisherTrusted },
	})) {
		const record = decode(TrustedPublisherRecordSchema, entry.event.data);
		if (record && parseTrustedPublisher(record).ok)
			out.set(record.name, record);
	}
	return out;
}
