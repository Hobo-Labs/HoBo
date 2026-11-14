/**
 * Short-lived elevated access capabilities (audience-bound JWT-SVIDs).
 * Mint only after lower-env authn, step-up, dual approval, or break-glass.
 * Network membership alone is never sufficient.
 *
 * One SVID implementation (ADR-0182, fleet ledger §8.3): a capability is
 * minted through `@hobo/identity`'s `JwtSvidIssuer` and verified with its
 * `verifyJwtWithJwks` over the issuer's key set, both passed in as the
 * ports below. There is no shared secret and no development default: without
 * a verifier no elevated token is accepted. For offline development the
 * issuer runs over `@hobo/identity`'s in-memory KMS.
 */
import { createHash, randomBytes } from "node:crypto";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
} from "../json.js";
import {
	ACCESS_EVENTS,
	type AccessEvent,
	createAccessEvent,
} from "./events.js";
import {
	ELEVATED_ACCESS_SCHEMA,
	type ElevatedAccessCapability,
} from "./grants.js";
import {
	ELEVATED_CAPABILITY_TTL_SECONDS,
	type IsolationClass,
	isExpired,
} from "./types.js";

// public-contract: the SVID scope port that marks a JWT-SVID as an elevated access capability.
export const ELEVATED_ACCESS_SCOPE_PORT = "elevated-access";

/** The claims `@hobo/identity`'s `JwtSvidIssuer.signJwtSvid` takes. */
// domain-view: structurally JwtSvidClaims of @hobo/identity, which @hobo/connectivity does not import (design §11.2 step 6).
export type ElevatedSvidClaims = Readonly<{
	sub: string;
	aud: string | readonly string[];
	tenant: string;
	parentPrincipal: Readonly<{ kind: string; id: string }>;
	codeVersion: Readonly<{ digest: string; version: string }>;
	scope: readonly Readonly<{
		port: string;
		resource: string;
		verbs: readonly string[];
	}>[];
	exp: number;
	nbf: number;
	iat: number;
	iss?: string;
}>;

/** Mints elevated capabilities: `@hobo/identity`'s `JwtSvidIssuer`. */
export type ElevatedCapabilityIssuer = Readonly<{
	issuerUrl: string;
	signJwtSvid(claims: ElevatedSvidClaims): Promise<string>;
}>;

/**
 * Verifies a JWT-SVID's signature, issuer, audience and time window and
 * answers its claims, or throws: `(token, options) =>
 * verifyJwtWithJwks(token, issuer.jwks(), options)` of `@hobo/identity`.
 */
export type ElevatedCapabilityVerifier = (
	token: string,
	options: { issuer: string; audience: string; now: number },
) => Promise<Readonly<{ claims: JsonObject }>>;

/** What a check needs to accept an elevated token: whose tokens, and how to verify them. */
export type ElevatedCapabilityTrust = Readonly<{
	issuer: string;
	verify: ElevatedCapabilityVerifier;
}>;

export type MintElevatedInput = Readonly<{
	subject: string;
	isolationClass: IsolationClass;
	/** e.g. production-access */
	audience?: string;
	priorAuthnClass?: IsolationClass;
	issuedBy: string;
	ttlSeconds?: number;
	obligations?: readonly string[];
	/** Evidence of prior lower-env authn / dual approval / break-glass id. */
	evidence: Readonly<{
		kind: "lower-env-authn" | "step-up-mfa" | "dual-approval" | "break-glass";
		ref: string;
	}>;
	issuer: ElevatedCapabilityIssuer;
	now?: string;
}>;

export type VerifiedElevatedAccess = Readonly<{
	ok: true;
	capability: ElevatedAccessCapability;
	tokenClaims: Readonly<{ sub: string; aud: readonly string[]; exp: number }>;
}>;

export type ElevatedAccessRefusal = Readonly<{
	ok: false;
	code: string;
	reason: string;
}>;

/**
 * Mint an elevated-access capability as an audience-bound short-lived JWT-SVID.
 */
export async function mintElevatedAccessCapability(
	input: MintElevatedInput,
	options?: {
		readonly tenant?: string;
		readonly events?: AccessEvent[];
	},
): Promise<
	Readonly<{
		capability: ElevatedAccessCapability;
		token: string;
		event: AccessEvent;
	}>
> {
	const t = input.now ?? new Date().toISOString();
	const ttl = input.ttlSeconds ?? ELEVATED_CAPABILITY_TTL_SECONDS;
	const audience = input.audience ?? `${input.isolationClass}-access`;
	const id = `elev_${randomBytes(8).toString("hex")}`;
	const tenant = options?.tenant ?? "local";
	const spiffeId = input.subject.startsWith("spiffe://")
		? input.subject
		: `spiffe://yard/${input.subject}`;
	const obligations = Object.freeze([
		...(input.obligations ?? ["short-lived", "audience-bound", "audit"]),
		`evidence:${input.evidence.kind}`,
	]);
	const issuedAtSeconds = Math.floor(Date.parse(t) / 1000);

	const token = await input.issuer.signJwtSvid({
		sub: spiffeId,
		aud: [audience, `env:${input.isolationClass}`],
		tenant,
		parentPrincipal: { kind: "elevated-access-issuer", id: input.issuedBy },
		codeVersion: { digest: "", version: ELEVATED_ACCESS_SCHEMA },
		scope: [
			{
				port: ELEVATED_ACCESS_SCOPE_PORT,
				resource: id,
				verbs: obligations,
			},
		],
		iat: issuedAtSeconds,
		nbf: issuedAtSeconds,
		exp: issuedAtSeconds + ttl,
	});

	const tokenRef = `tokenref://elevated/${id}`;
	const capability: ElevatedAccessCapability = Object.freeze({
		schemaVersion: ELEVATED_ACCESS_SCHEMA,
		id,
		subject: input.subject,
		audience,
		isolationClass: input.isolationClass,
		issuedAt: t,
		expiresAt: new Date(Date.parse(t) + ttl * 1000).toISOString(),
		...(input.priorAuthnClass !== undefined
			? { priorAuthnClass: input.priorAuthnClass }
			: undefined),
		obligations,
		tokenRef,
	});

	const event = createAccessEvent({
		type: ACCESS_EVENTS.ElevatedMinted,
		tenant,
		actor: input.issuedBy,
		time: t,
		data: {
			capabilityId: id,
			subject: input.subject,
			isolationClass: input.isolationClass,
			audience,
			expiresAt: capability.expiresAt,
			evidenceKind: input.evidence.kind,
			evidenceRef: input.evidence.ref,
			tokenRef,
			tokenDigest: createHash("sha256")
				.update(token)
				.digest("hex")
				.slice(0, 16),
		},
	});
	options?.events?.push(event);

	return { capability, token, event };
}

const refusal = (code: string, reason: string): ElevatedAccessRefusal => ({
	ok: false,
	code,
	reason,
});

/** The elevated-access scope entry of verified claims: its capability id and obligations. */
function elevatedScope(
	claims: JsonObject,
): Readonly<{ id: string; obligations: readonly string[] }> | undefined {
	const scope = claims.scope;
	if (!Array.isArray(scope)) return undefined;
	for (const entry of scope) {
		if (
			!isJsonObject(entry) ||
			entry.port !== ELEVATED_ACCESS_SCOPE_PORT ||
			!isJsonString(entry.resource)
		)
			continue;
		const verbs = Array.isArray(entry.verbs)
			? entry.verbs.filter((verb) => isJsonString(verb))
			: [];
		return { id: entry.resource, obligations: verbs };
	}
	return undefined;
}

/**
 * Verify an elevated capability token. Fail-closed on a missing verifier,
 * signature, issuer, expiry, audience, or env mismatch.
 */
export async function verifyElevatedAccessCapability(input: {
	readonly token: string;
	readonly expectedAudience: string;
	readonly expectedIsolationClass: IsolationClass;
	readonly trust: ElevatedCapabilityTrust | undefined;
	readonly now?: string;
}): Promise<VerifiedElevatedAccess | ElevatedAccessRefusal> {
	if (input.trust === undefined)
		return refusal(
			"elevated-unverifiable",
			"no elevated-capability issuer is configured; elevated tokens are refused",
		);
	const nowIso = input.now ?? new Date().toISOString();
	let claims: JsonObject;
	try {
		({ claims } = await input.trust.verify(input.token, {
			issuer: input.trust.issuer,
			audience: input.expectedAudience,
			now: Math.floor(Date.parse(nowIso) / 1000),
		}));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return refusal(
			/expired/iu.test(message) ? "elevated-expired" : "elevated-invalid",
			message,
		);
	}
	const aud = Array.isArray(claims.aud)
		? claims.aud.filter((value) => isJsonString(value))
		: isJsonString(claims.aud)
			? [claims.aud]
			: [];
	const envAud = `env:${input.expectedIsolationClass}`;
	if (!aud.includes(envAud))
		return refusal("elevated-wrong-env", `token missing audience ${envAud}`);
	const scope = elevatedScope(claims);
	if (
		scope === undefined ||
		!isJsonString(claims.sub) ||
		!isJsonNumber(claims.exp) ||
		!isJsonNumber(claims.iat)
	)
		return refusal(
			"elevated-invalid",
			"the token is not an elevated access capability",
		);
	const expiresAt = new Date(claims.exp * 1000).toISOString();
	if (isExpired(expiresAt, nowIso))
		return refusal("elevated-expired", "elevated capability expired");

	const capability: ElevatedAccessCapability = Object.freeze({
		schemaVersion: ELEVATED_ACCESS_SCHEMA,
		id: scope.id,
		subject: claims.sub,
		audience: input.expectedAudience,
		isolationClass: input.expectedIsolationClass,
		issuedAt: new Date(claims.iat * 1000).toISOString(),
		expiresAt,
		obligations: Object.freeze([...scope.obligations]),
		tokenRef: `tokenref://elevated/${scope.id}`,
	});

	return {
		ok: true,
		capability,
		tokenClaims: { sub: claims.sub, aud, exp: claims.exp },
	};
}

export function elevatedDeniedEvent(input: {
	readonly tenant: string;
	readonly actor: string;
	readonly code: string;
	readonly reason: string;
}): AccessEvent {
	return createAccessEvent({
		type: ACCESS_EVENTS.ElevatedDenied,
		tenant: input.tenant,
		actor: input.actor,
		data: { code: input.code, reason: input.reason },
	});
}
