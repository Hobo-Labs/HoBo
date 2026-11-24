/**
 * Dual-principal credential presentation for remote broker calls.
 *
 * - Human principal: from `hobo login` / profile OIDC session
 * - Agent/workload principal: SPIFFE JWT-SVID + real DPoP (ES256) binding
 * - Anonymous ephemeral: temporary principal + claim token material
 *
 * DPoP proofs are mint+verify capable (RFC 9449). JWT-SVIDs are audience-bound
 * and short-lived. SPIRE Workload API can replace mint with a fetch later
 * without changing presentAuthenticated call sites.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_SVID_HMAC_SECRET,
	type DpopKeyPair,
	exportDpopPrivateJwk,
	generateDpopKeyPair,
	importDpopKeyPair,
	mintDpopProof,
	mintJwtSvid,
	spiffeIdForAgent,
	verifyDpopProof,
	verifyJwtSvid,
} from "@hobo/connectivity";
import type { PrincipalRef } from "@hobo/core";
import type { HoboProfile } from "./hobo-profile.js";
import { loadHoboProfile } from "./hobo-profile.js";
import type { JsonObject } from "./json.js";

export type CredentialScheme =
	| "local-fixture-svid"
	| "spiffe-jwt-svid"
	| "dpop-bound"
	| "anonymous-ephemeral"
	| "bearer-session";

export interface PresentedCredential {
	readonly scheme: CredentialScheme;
	readonly principal: PrincipalRef;
	/** Human principal when an agent acts on behalf of a user (never collapsed). */
	readonly humanPrincipal?: PrincipalRef;
	readonly tenant: string;
	/** Audience-bound token (never log full value in production). */
	readonly accessToken: string;
	readonly audience: string;
	readonly expiresAt: string;
	/** DPoP proof JWT (ES256) when scheme is dpop-bound. */
	readonly dpopProof?: string;
	readonly proofKeyId?: string;
	readonly metadata?: Readonly<Record<string, string>>;
}

export interface CredentialPresenter {
	presentAuthenticated(input: {
		readonly audience: string;
		readonly hoboHome: string;
		readonly env?: NodeJS.ProcessEnv;
		readonly requirePrincipal?: boolean;
		/** HTTP method for DPoP htm (default POST). */
		readonly htm?: string;
	}): Promise<PresentedCredential | null>;

	presentAnonymous(input: {
		readonly audience: string;
		readonly ephemeralPrincipal: PrincipalRef;
		readonly accessToken: string;
		readonly expiresAt: string;
		readonly tenant?: string;
	}): PresentedCredential;
}

export function createCredentialPresenter(options?: {
	readonly agentPrincipal?: PrincipalRef;
	readonly humanPrincipal?: PrincipalRef;
	/** Inject DPoP key pair (tests). */
	readonly dpopKeyPair?: DpopKeyPair;
	readonly svidHmacSecret?: string;
}): CredentialPresenter {
	return {
		async presentAuthenticated(input) {
			const env = input.env ?? process.env;
			const profile = loadHoboProfile(input.hoboHome);

			const agent = resolveAgentPrincipal(env, options?.agentPrincipal);
			const human =
				options?.humanPrincipal ?? profile?.session?.principal ?? null;
			const htm = input.htm ?? "POST";

			if (agent) {
				const spiffeId =
					env.HOBO_SPIFFE_ID ??
					(agent.id.startsWith("spiffe://")
						? agent.id
						: spiffeIdForAgent(agent.id));
				const svid = mintJwtSvid({
					spiffeId,
					audience: input.audience,
					ttlSeconds: 900,
					issuer: env.HOBO_SVID_ISSUER ?? "spiffe://hobo.local",
					env,
					...(options?.svidHmacSecret !== undefined
						? { hmacSecret: options.svidHmacSecret }
						: undefined),
				});
				// Validate self-mint (ensures verify path is exercised).
				verifyJwtSvid({
					token: svid.token,
					audience: input.audience,
					hmacSecret: options?.svidHmacSecret ?? DEFAULT_SVID_HMAC_SECRET,
				});

				const keyPair =
					options?.dpopKeyPair ??
					loadOrCreateDpopKeyPair(input.hoboHome, agent.id);
				const dpopProof = mintDpopProof({
					keyPair,
					htm,
					htu: input.audience,
					accessToken: svid.token,
				});
				// Round-trip verify so broken proofs never leave the presenter.
				verifyDpopProof({
					proof: dpopProof,
					htm,
					htu: input.audience,
					accessToken: svid.token,
				});

				return {
					scheme: "dpop-bound",
					principal: { kind: "agent", id: agent.id },
					...(human !== null ? { humanPrincipal: human } : undefined),
					tenant: env.HOBO_TENANT ?? profile?.session?.tenant ?? "hobo-dev",
					accessToken: svid.token,
					audience: input.audience,
					expiresAt: new Date(svid.claims.exp * 1000).toISOString(),
					dpopProof,
					proofKeyId: keyPair.kid,
					metadata: {
						spiffeId,
						credentialScheme: "spiffe-jwt-svid+dpop",
						svidAlg: "HS256",
						dpopAlg: "ES256",
					},
				};
			}

			if (profile?.session) {
				const session = profile.session;
				const keyPair =
					session.proofKeyId !== undefined
						? loadOrCreateDpopKeyPair(input.hoboHome, session.principal.id)
						: null;
				if (keyPair) {
					const dpopProof = mintDpopProof({
						keyPair,
						htm,
						htu: input.audience,
						accessToken: session.token,
					});
					verifyDpopProof({
						proof: dpopProof,
						htm,
						htu: input.audience,
						accessToken: session.token,
					});
					return {
						scheme: "dpop-bound",
						principal: session.principal,
						tenant: session.tenant,
						accessToken: session.token,
						audience: input.audience,
						expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
						dpopProof,
						proofKeyId: keyPair.kid,
					};
				}
				return {
					scheme: "bearer-session",
					principal: session.principal,
					tenant: session.tenant,
					accessToken: session.token,
					audience: input.audience,
					expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
				};
			}

			if (input.requirePrincipal === true) {
				return null;
			}

			// Local/dev fixture path — offline capable, still DPoP-bound.
			const principal: PrincipalRef = {
				kind: "user",
				id: "user:local-fixture",
			};
			const svid = mintJwtSvid({
				spiffeId: "spiffe://hobo.local/user/local-fixture",
				audience: input.audience,
				ttlSeconds: 3600,
				env,
				allowDefaultSecret: true,
				...(options?.svidHmacSecret !== undefined
					? { hmacSecret: options.svidHmacSecret }
					: undefined),
			});
			const keyPair =
				options?.dpopKeyPair ??
				loadOrCreateDpopKeyPair(input.hoboHome, principal.id);
			const dpopProof = mintDpopProof({
				keyPair,
				htm,
				htu: input.audience,
				accessToken: svid.token,
			});
			return {
				scheme: "local-fixture-svid",
				principal,
				tenant: env.HOBO_TENANT ?? "hobo-dev",
				accessToken: svid.token,
				audience: input.audience,
				expiresAt: new Date(svid.claims.exp * 1000).toISOString(),
				dpopProof,
				proofKeyId: keyPair.kid,
				metadata: { fixture: "true", spiffeId: svid.spiffeId },
			};
		},

		presentAnonymous(input) {
			return {
				scheme: "anonymous-ephemeral",
				principal: input.ephemeralPrincipal,
				tenant: input.tenant ?? "anonymous",
				accessToken: input.accessToken,
				audience: input.audience,
				expiresAt: input.expiresAt,
			};
		},
	};
}

function resolveAgentPrincipal(
	env: NodeJS.ProcessEnv,
	forced?: PrincipalRef,
): PrincipalRef | null {
	if (forced) return forced;
	if (env.HOBO_AGENT_ID) {
		return { kind: "agent", id: env.HOBO_AGENT_ID };
	}
	const svid = env.HOBO_AGENT_SVID ?? env.SPIFFE_ENDPOINT_SOCKET;
	if (!svid || svid.length === 0) return null;
	if (svid.startsWith("spiffe://")) {
		return { kind: "agent", id: svid };
	}
	return {
		kind: "agent",
		id: `agent:${svid.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 32)}`,
	};
}

function dpopKeyPath(hoboHome: string, principalId: string): string {
	const safe = principalId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 64);
	return join(hoboHome, "keys", `dpop-${safe}.json`);
}

export function loadOrCreateDpopKeyPair(
	hoboHome: string,
	principalId: string,
): DpopKeyPair {
	const path = dpopKeyPath(hoboHome, principalId);
	if (existsSync(path)) {
		// SAFETY: assertion required at this I/O or test boundary.
		const raw = JSON.parse(readFileSync(path, "utf8")) as JsonObject;
		return importDpopKeyPair({ privateJwk: raw });
	}
	const pair = generateDpopKeyPair();
	const keysDir = join(hoboHome, "keys");
	mkdirSync(keysDir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(keysDir, 0o700);
	} catch {
		// best-effort on platforms without chmod
	}
	writeFileSync(
		path,
		`${JSON.stringify(exportDpopPrivateJwk(pair), null, 2)}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
	try {
		chmodSync(path, 0o600);
	} catch {
		// best-effort
	}
	return pair;
}

interface HttpHeaders {
	[header: string]: string;
}

export function authorizationHeaders(credential: PresentedCredential) {
	const headers: HttpHeaders = {
		authorization: `Bearer ${credential.accessToken}`,
		"x-hobo-principal-kind": credential.principal.kind,
		"x-hobo-principal-id": credential.principal.id,
		"x-hobo-tenant": credential.tenant,
		"x-hobo-credential-scheme": credential.scheme,
	};
	if (credential.humanPrincipal) {
		headers["x-hobo-human-principal-id"] = credential.humanPrincipal.id;
		headers["x-hobo-human-principal-kind"] = credential.humanPrincipal.kind;
	}
	if (credential.dpopProof) {
		headers.dpop = credential.dpopProof;
	}
	if (credential.metadata?.spiffeId) {
		headers["x-hobo-spiffe-id"] = credential.metadata.spiffeId;
	}
	return headers;
}

/** @deprecated use mintDpopProof from @hobo/connectivity */
export function mintMockDpopProof(input: {
	readonly htm: string;
	readonly htu: string;
	readonly ath: string;
	readonly keyId: string;
}): string {
	const pair = generateDpopKeyPair(input.keyId);
	return mintDpopProof({
		keyPair: pair,
		htm: input.htm,
		htu: input.htu,
		accessToken: input.ath,
	});
}

export function profileHasSession(
	profile: HoboProfile | null,
): profile is HoboProfile & { session: NonNullable<HoboProfile["session"]> } {
	return profile?.session !== undefined;
}
