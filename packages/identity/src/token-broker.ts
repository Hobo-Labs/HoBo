import { createHash, createHmac } from "node:crypto";
import {
	createTokenGrantedEvent,
	createTokenRevokedEvent,
	createTokenUsedEvent,
	type TokenEvent,
	type TokenScope,
	validateTokenEvent,
} from "./events.js";
import type { ActiveSvidRecord } from "./identity-service.js";
import { isJsonString, type JsonObject } from "./json.js";

export const TOKEN_BROKER_DEFAULT_TTL_SECONDS = 900;

export interface BrokeredCounts {
	readonly federated: number;
	readonly fallback: number;
}

// domain-view: an abstract vaulted root credential. The raw secret never leaves
// the vault: callers can only (a) read a non-secret reference and (b) ask the
// vault to derive non-invertible, scope-bound material by keyed HMAC. No real
// secret is hardcoded — the in-memory fixture vault takes its root secret from
// its constructor.
export type VaultedCredential = Readonly<{
	reference: string;
	deriveScopedMaterial(bindingMaterial: string): string;
	matchesReference(candidate: string): boolean;
}>;

export function createInMemoryVault(options: {
	reference: string;
	rootSecret: string;
}): VaultedCredential {
	// The root secret is closed over and is never re-exposed. Only HMAC-derived
	// (one-way) material ever crosses the boundary, so a scoped token cannot be
	// inverted back to the vaulted root credential.
	const rootSecret = options.rootSecret;
	const reference = options.reference;
	return Object.freeze({
		reference,
		deriveScopedMaterial(bindingMaterial: string): string {
			return createHmac("sha256", rootSecret)
				.update(bindingMaterial)
				.digest("base64url");
		},
		matchesReference(candidate: string): boolean {
			return candidate === reference;
		},
	});
}

// ---------------------------------------------------------------------------
// S3-03: keyless provider-STS token exchange (ai-native-agent-auth.md §6.2/§6.8)
//
// Keyless-by-default preference order (oidc-federation > … > api-key): rather than
// derive a token from the vaulted static key, the broker mints an OIDC assertion
// (aud = provider) for the attested SVID and exchanges it at the provider's STS
// (AssumeRoleWithWebIdentity / GCP WIF / Azure federated credential / RFC 8693)
// for a short-lived, resource-scoped provider token. The vaulted static key is a
// bounded escape hatch, used only when federation is unavailable (NFR-005: the
// brokered ratio must stay ≥99%).
// ---------------------------------------------------------------------------

export type BrokeredCredentialSource =
	| "oidc-federation"
	| "vault-static-key"
	| "connection-obo";

export const BROKER_OIDC_ASSERTION_TTL_SECONDS = 120;

// domain-view: the OIDC assertion the broker federates to the provider. Wire form
// is OidcFederationAssertion in data-models/identity.proto. The broker holds no
// provider secret — the assertion is the only thing that crosses to the STS.
export type OidcFederationAssertion = Readonly<{
	token: string;
	issuer: string;
	subject: string;
	audience: string;
	scope: TokenScope;
	issuedAt: string;
	expiresAt: string;
}>;

// domain-view: the request the broker submits to a provider STS. Wire form is
// ProviderStsExchangeRequest in data-models/identity.proto.
export type StsExchangeRequest = Readonly<{
	oidcToken: string;
	audience: string;
	subject: string;
	scope: TokenScope;
	now: string;
}>;

// domain-view: a short-lived, resource-scoped provider credential returned by the
// exchange. Wire form is ExchangedProviderCredential in identity.proto — the wire
// record carries only the reference, never the raw provider token material.
export type ExchangedProviderCredential = Readonly<{
	tokenRef: string;
	token: string;
	flow: "oidc-federation";
	provider: string;
	audience: string;
	scope: TokenScope;
	issuedAt: string;
	expiresAt: string;
	expiresInSeconds: number;
	narrowed: true;
}>;

export type StsExchangeResult =
	| Readonly<{ status: "exchanged"; credential: ExchangedProviderCredential }>
	| Readonly<{ status: "rejected"; reason: string }>;

/**
 * The typed provider-STS port. A production adapter fronts a real cloud STS
 * (AssumeRoleWithWebIdentity / WIF / federated credential / RFC 8693 token
 * exchange). The in-memory implementation below models the exchange
 * deterministically with no network and no cloud SDK.
 */
export interface ProviderStsExchange {
	readonly provider: string;
	readonly audience: string;
	readonly flow: "oidc-federation";
	exchange(request: StsExchangeRequest): StsExchangeResult;
}

/**
 * Deterministic in-memory STS modelling an `AssumeRoleWithWebIdentity`-style
 * exchange. It trusts assertions minted for its own `audience`, rejects an
 * expired/past-TTL assertion, and mints a narrowed, resource-scoped provider
 * token that is NOT derived from any vaulted static secret (federation needs no
 * long-lived provider key). Pass `available: false` to model a provider whose
 * federation endpoint is down, which forces the broker's bounded static-key
 * fallback.
 */
export function createInMemoryProviderStsExchange(options: {
	provider: string;
	audience: string;
	ttlSeconds?: number;
	available?: boolean;
}): ProviderStsExchange {
	const provider = options.provider;
	const audience = options.audience;
	const ttlSeconds = options.ttlSeconds ?? 600;
	const available = options.available ?? true;
	let seq = 0;

	return {
		provider,
		audience,
		flow: "oidc-federation",
		exchange(request: StsExchangeRequest): StsExchangeResult {
			if (!available) {
				return { status: "rejected", reason: "federation-unavailable" };
			}
			const assertion = decodeOidcAssertion(request.oidcToken);
			if (!assertion) {
				return { status: "rejected", reason: "malformed-oidc-assertion" };
			}
			// Provider trust: the STS only accepts assertions minted for its audience.
			if (assertion.aud !== audience || request.audience !== audience) {
				return { status: "rejected", reason: "audience-not-trusted" };
			}
			if (assertion.sub !== request.subject) {
				return { status: "rejected", reason: "subject-mismatch" };
			}
			// Reject an expired / past-TTL assertion — no token minted from stale input.
			if (Date.parse(request.now) >= Date.parse(assertion.exp)) {
				return { status: "rejected", reason: "oidc-assertion-expired" };
			}

			const n = seq;
			seq += 1;
			const tokenRef = `tokenref://provider/${provider}/${request.scope.resource}/${request.scope.action}/${n}`;
			const token = `providertok_${createHash("sha256")
				.update(
					`${provider}:${request.subject}:${request.scope.resource}:${request.scope.action}:${n}`,
				)
				.digest("base64url")}`;
			const expiresAt = new Date(
				Date.parse(request.now) + ttlSeconds * 1000,
			).toISOString();

			return {
				status: "exchanged",
				credential: {
					tokenRef,
					token,
					flow: "oidc-federation",
					provider,
					audience,
					scope: request.scope,
					issuedAt: request.now,
					expiresAt,
					expiresInSeconds: ttlSeconds,
					narrowed: true,
				},
			};
		},
	};
}

/**
 * Mint the OIDC assertion (aud = provider) the broker federates to the STS. The
 * `tag` stands in for the Yard issuer's KMS signature (real signing is the
 * issuer's, out of scope for S3-03); no provider secret is ever involved.
 */
export function mintOidcFederationAssertion(input: {
	issuer: string;
	subject: string;
	audience: string;
	scope: TokenScope;
	now: string;
	ttlSeconds?: number;
}): OidcFederationAssertion {
	const ttlSeconds = input.ttlSeconds ?? BROKER_OIDC_ASSERTION_TTL_SECONDS;
	const issuedAt = input.now;
	const expiresAt = new Date(
		Date.parse(input.now) + ttlSeconds * 1000,
	).toISOString();
	const payload = {
		iss: input.issuer,
		sub: input.subject,
		aud: input.audience,
		scope: input.scope,
		iat: issuedAt,
		exp: expiresAt,
	};
	const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
	const tag = createHash("sha256").update(encoded).digest("base64url");
	return {
		token: `hobo-oidc.${encoded}.${tag}`,
		issuer: input.issuer,
		subject: input.subject,
		audience: input.audience,
		scope: input.scope,
		issuedAt,
		expiresAt,
	};
}

type DecodedOidcAssertion = {
	iss: string;
	sub: string;
	aud: string;
	exp: string;
};

function decodeOidcAssertion(token: string): DecodedOidcAssertion | undefined {
	const parts = token.split(".");
	if (parts.length !== 3 || parts[0] !== "hobo-oidc") return undefined;
	try {
		const parsed = JSON.parse(
			Buffer.from(parts[1] ?? "", "base64url").toString("utf8"),
		);
		// SAFETY: OIDC assertion payload is JSON-parsed at this token boundary.
		const payload = parsed as JsonObject;
		if (
			!isJsonString(payload.iss) ||
			!isJsonString(payload.sub) ||
			!isJsonString(payload.aud) ||
			!isJsonString(payload.exp)
		) {
			return undefined;
		}
		return {
			iss: payload.iss,
			sub: payload.sub,
			aud: payload.aud,
			exp: payload.exp,
		};
	} catch {
		return undefined;
	}
}

// domain-view: a minted, per-deploy, scope-bound broker token. Its generated
// wire form is TokenGrantRecord in data-models/identity.proto.
export type ScopedTokenGrant = Readonly<{
	grantId: string;
	token: string;
	svidSubject: string;
	svidIdentityId: string;
	scope: TokenScope;
	deployId: string;
	audience: string;
	issuedAt: string;
	expiresAt: string;
	tokenRef: string;
	vaultReference: string;
	credentialSource: BrokeredCredentialSource;
	providerTokenRef?: string;
	/** When minted via a first-class Connection (XAA/OBO path). */
	connectionId?: string;
}>;

export type GrantTokenResult =
	| Readonly<{
			status: "granted";
			grant: ScopedTokenGrant;
			events: readonly TokenEvent[];
	  }>
	| Readonly<{
			status: "denied";
			reason: string;
			events: readonly TokenEvent[];
	  }>;

export type UseTokenResult =
	| Readonly<{
			status: "used";
			grant: ScopedTokenGrant;
			events: readonly TokenEvent[];
	  }>
	| Readonly<{
			status: "denied";
			reason: string;
			events: readonly TokenEvent[];
	  }>;

export type RevokeTokenResult =
	| Readonly<{ status: "revoked"; events: readonly TokenEvent[] }>
	| Readonly<{
			status: "denied";
			reason: string;
			events: readonly TokenEvent[];
	  }>;

/**
 * Per-deploy token broker. Holds a single vaulted root credential and mints
 * short-lived, scope-bound tokens for an attested SVID. Every mint/use/revoke is
 * an event carrying the never-compact credential-audit retention.
 *
 * Scope is narrowed, never widened: a broker token's `(port, resource, action)`
 * must be authorized by the SVID's own `(port, resource, verbs[])` scope.
 */
export class TokenBroker {
	private readonly vault: VaultedCredential;
	readonly ttlSeconds: number;
	readonly audience: string;
	readonly issuer: string;
	readonly oidcTtlSeconds: number;
	private readonly sts?: ProviderStsExchange;
	readonly events: TokenEvent[] = [];
	private readonly grants = new Map<string, ScopedTokenGrant>();
	private readonly revoked = new Set<string>();
	private seq = 0;
	// NFR-005 brokered-ratio signal: how many grants were keyless-federated vs how
	// many fell back to the bounded vaulted static key.
	private federatedGrants = 0;
	private fallbackGrants = 0;

	constructor(options: {
		vault: VaultedCredential;
		audience: string;
		ttlSeconds?: number;
		sts?: ProviderStsExchange;
		issuer?: string;
		oidcTtlSeconds?: number;
	}) {
		this.vault = options.vault;
		this.audience = options.audience;
		this.ttlSeconds = options.ttlSeconds ?? TOKEN_BROKER_DEFAULT_TTL_SECONDS;
		this.sts = options.sts;
		this.issuer = options.issuer ?? "https://identity.yard.example";
		this.oidcTtlSeconds =
			options.oidcTtlSeconds ?? BROKER_OIDC_ASSERTION_TTL_SECONDS;
	}

	/** Fraction of grants brokered keylessly (oidc-federation) — NFR-005 target ≥0.99. */
	brokeredRatio(): number {
		const total = this.federatedGrants + this.fallbackGrants;
		return total === 0 ? 1 : this.federatedGrants / total;
	}

	get brokeredCounts(): BrokeredCounts {
		return { federated: this.federatedGrants, fallback: this.fallbackGrants };
	}

	/**
	 * Preference order (ai-native-agent-auth + first-class Connections):
	 * 1. Keyless OIDC federation (no Connection required for pure cloud ports)
	 * 2. Healthy matching Connection (connectionId / connectionCredentialRef)
	 * 3. Bounded vault static-key fallback
	 */
	grantForDeploy(input: {
		svid: ActiveSvidRecord;
		scope: TokenScope;
		deployId: string;
		now?: string;
		/** Optional first-class Connection id used for XAA/OBO. */
		connectionId?: string;
		/** Opaque vault ref from an authorized Connection (never the secret). */
		connectionCredentialRef?: string;
		/** Provider name when using a Connection (e.g. asana). */
		connectionProvider?: string;
	}): GrantTokenResult {
		if (!svidAuthorizesScope(input.svid, input.scope)) {
			return {
				status: "denied",
				reason: "scope-not-authorized-by-svid",
				events: [],
			};
		}

		const nowIso = input.now ?? new Date().toISOString();
		const tenant = tenantOfSubject(input.svid.subject);
		const grantId = `grant-${input.deployId}-${input.svid.identityId}`;

		// Keyless-by-default: prefer an OIDC-federation token exchange; the vaulted
		// static key is a bounded escape hatch used only when federation is
		// unavailable (ai-native-agent-auth.md §6.2).
		const federation = this.tryFederate({
			svid: input.svid,
			scope: input.scope,
			nowIso,
		});
		if (federation.status === "denied") {
			return { status: "denied", reason: federation.reason, events: [] };
		}

		let token: string;
		let expiresAt: string;
		let credentialSource: BrokeredCredentialSource;
		let providerTokenRef: string | undefined;
		let connectionId: string | undefined;

		if (federation.status === "exchanged") {
			// Keyless: the provider STS returned a short-lived, resource-scoped token.
			token = federation.credential.token;
			expiresAt = federation.credential.expiresAt;
			providerTokenRef = federation.credential.tokenRef;
			credentialSource = "oidc-federation";
			this.federatedGrants += 1;
		} else if (
			input.connectionId !== undefined &&
			input.connectionCredentialRef !== undefined
		) {
			// Connection-aware OBO/XAA path: broker holds vault ref only; mint
			// short-lived audience-bound token derived from Connection material.
			expiresAt = new Date(
				Date.parse(nowIso) + this.ttlSeconds * 1000,
			).toISOString();
			const binding = JSON.stringify({
				grantId,
				subject: input.svid.subject,
				identityId: input.svid.identityId,
				scope: input.scope,
				deployId: input.deployId,
				audience: this.audience,
				expiresAt,
				connectionId: input.connectionId,
				connectionCredentialRef: input.connectionCredentialRef,
				connectionProvider: input.connectionProvider ?? null,
				vaultReference: this.vault.reference,
			});
			token = `hobotok_conn_${this.vault.deriveScopedMaterial(binding)}`;
			credentialSource = "connection-obo";
			connectionId = input.connectionId;
			providerTokenRef = `tokenref://connection/${input.connectionId}/grant/${grantId}`;
			this.federatedGrants += 1;
		} else {
			// Bounded fallback: no STS wired, or the provider's federation is down.
			expiresAt = new Date(
				Date.parse(nowIso) + this.ttlSeconds * 1000,
			).toISOString();
			// Deterministic binding material commits the token to this exact SVID,
			// scope, deploy, and expiry. The vault turns it into non-invertible material.
			const binding = JSON.stringify({
				grantId,
				subject: input.svid.subject,
				identityId: input.svid.identityId,
				scope: input.scope,
				deployId: input.deployId,
				audience: this.audience,
				expiresAt,
				vaultReference: this.vault.reference,
			});
			token = `hobotok_${this.vault.deriveScopedMaterial(binding)}`;
			credentialSource = "vault-static-key";
			this.fallbackGrants += 1;
		}

		const tokenRef = `tokenref://broker/grant/${grantId}`;

		const grant: ScopedTokenGrant = {
			grantId,
			token,
			svidSubject: input.svid.subject,
			svidIdentityId: input.svid.identityId,
			scope: input.scope,
			deployId: input.deployId,
			audience: this.audience,
			issuedAt: nowIso,
			expiresAt,
			tokenRef,
			vaultReference: this.vault.reference,
			credentialSource,
			...(providerTokenRef !== undefined ? { providerTokenRef } : undefined),
			...(connectionId !== undefined ? { connectionId } : undefined),
		};
		this.grants.set(grantId, grant);

		const event = createTokenGrantedEvent({
			grantId,
			svidSubject: grant.svidSubject,
			svidIdentityId: grant.svidIdentityId,
			tokenRef,
			scope: input.scope,
			expiresAt,
			tenant,
			seq: this.nextSeq(),
			time: nowIso,
			...(connectionId !== undefined ? { connectionId } : undefined),
			credentialSource,
		});
		validateTokenEvent(event);
		this.events.push(event);

		return { status: "granted", grant, events: [event] };
	}

	useToken(input: { grantId: string; now?: string }): UseTokenResult {
		const grant = this.grants.get(input.grantId);
		if (!grant) {
			return { status: "denied", reason: "unknown-grant", events: [] };
		}
		if (this.revoked.has(input.grantId)) {
			return { status: "denied", reason: "grant-revoked", events: [] };
		}
		const nowIso = input.now ?? new Date().toISOString();
		if (Date.parse(nowIso) >= Date.parse(grant.expiresAt)) {
			return { status: "denied", reason: "grant-expired", events: [] };
		}

		const event = createTokenUsedEvent({
			grantId: grant.grantId,
			svidSubject: grant.svidSubject,
			tokenRef: grant.tokenRef,
			scope: grant.scope,
			tenant: tenantOfSubject(grant.svidSubject),
			seq: this.nextSeq(),
			time: nowIso,
		});
		validateTokenEvent(event);
		this.events.push(event);

		return { status: "used", grant, events: [event] };
	}

	revokeToken(input: {
		grantId: string;
		reason: string;
		now?: string;
	}): RevokeTokenResult {
		const grant = this.grants.get(input.grantId);
		if (!grant) {
			return { status: "denied", reason: "unknown-grant", events: [] };
		}
		const nowIso = input.now ?? new Date().toISOString();
		this.revoked.add(input.grantId);

		const event = createTokenRevokedEvent({
			grantId: grant.grantId,
			svidSubject: grant.svidSubject,
			tokenRef: grant.tokenRef,
			reason: input.reason,
			tenant: tenantOfSubject(grant.svidSubject),
			seq: this.nextSeq(),
			time: nowIso,
		});
		validateTokenEvent(event);
		this.events.push(event);

		return { status: "revoked", events: [event] };
	}

	getGrant(grantId: string): ScopedTokenGrant | undefined {
		return this.grants.get(grantId);
	}

	getAuditEvents(): readonly TokenEvent[] {
		return [...this.events];
	}

	// Attempt the keyless OIDC-federation exchange. Returns "fallback" when no STS
	// is wired or the provider's federation endpoint is unavailable (→ bounded
	// static-key path), "denied" for a real exchange rejection (e.g. an expired
	// assertion or an untrusted audience), or the exchanged provider credential.
	private tryFederate(input: {
		svid: ActiveSvidRecord;
		scope: TokenScope;
		nowIso: string;
	}):
		| Readonly<{ status: "exchanged"; credential: ExchangedProviderCredential }>
		| Readonly<{ status: "fallback" }>
		| Readonly<{ status: "denied"; reason: string }> {
		if (!this.sts) {
			return { status: "fallback" };
		}
		const assertion = mintOidcFederationAssertion({
			issuer: this.issuer,
			subject: input.svid.subject,
			audience: this.audience,
			scope: input.scope,
			now: input.nowIso,
			ttlSeconds: this.oidcTtlSeconds,
		});
		const result = this.sts.exchange({
			oidcToken: assertion.token,
			audience: this.audience,
			subject: input.svid.subject,
			scope: input.scope,
			now: input.nowIso,
		});
		if (result.status === "exchanged") {
			return { status: "exchanged", credential: result.credential };
		}
		if (result.reason === "federation-unavailable") {
			return { status: "fallback" };
		}
		return { status: "denied", reason: `provider-sts-${result.reason}` };
	}

	private nextSeq(): number {
		this.seq += 1;
		return this.seq;
	}
}

function svidAuthorizesScope(
	svid: ActiveSvidRecord,
	scope: TokenScope,
): boolean {
	return svid.scope.some(
		(entry) =>
			entry.port === scope.port &&
			entry.resource === scope.resource &&
			entry.verbs.includes(scope.action),
	);
}

function tenantOfSubject(subject: string): string {
	// spiffe://yard/<tenant>/agent/<name>
	return subject.split("/")[3] ?? "unknown";
}
