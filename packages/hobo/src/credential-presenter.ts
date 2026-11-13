/**
 * Dual-principal credential presentation for remote broker calls.
 *
 * - Agent/workload principal: a JWT-SVID minted through `@hobo/identity`'s
 *   `JwtSvidIssuer` (RS256 over an in-memory key for offline development;
 *   never an HMAC secret) + DPoP (ES256) from `@hobo/fleet/keys`
 * - Human principal, fleet authority: the authority-issued, DPoP-bound person
 *   token `hobo fleet login` stored, when an authority is configured
 *   (HOBO_FLEET_AUTHORITY_URL)
 * - Human principal: from `hobo login` / profile OIDC session
 * - Anonymous ephemeral: temporary principal + claim token material
 *
 * Every SVID and DPoP proof is verified before it leaves the presenter.
 */

import {
	createPrivateKey,
	generateKeyPairSync,
	type KeyObject,
	sign,
} from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { PrincipalRef } from "@hobo/core";
import {
	KeyAlgorithm,
	type PublicJwk,
	parseKeyId,
	type Signer,
} from "@hobo/fleet";
import {
	jwkThumbprint,
	memberIdFromJwk,
	mintDpopProof,
	verifyDpopProof,
} from "@hobo/fleet/keys";
import {
	createInMemoryKms,
	JwtSvidIssuer,
	verifyJwtWithJwks,
} from "@hobo/identity";
import { fleetHome, readPerson } from "./fleet-home.js";
import type { HoboProfile } from "./hobo-profile.js";
import { loadHoboProfile } from "./hobo-profile.js";
import { isJsonObject, isJsonString } from "./json.js";

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

/** An ES256 DPoP key: its id (the RFC 7638 thumbprint), signer and public JWK. */
export type DpopKeyPair = Readonly<{
	kid: string;
	signer: Signer;
	publicJwk: PublicJwk;
}>;

const SVID_KEY_ID = "presenter-svid-1";
// public-contract: the trust domain of locally minted SVIDs when HOBO_SVID_ISSUER is unset.
export const LOCAL_SVID_ISSUER = "spiffe://hobo.local";

/** An RS256 JWT-SVID issuer over an in-memory key: offline development only. */
export function createLocalSvidIssuer(
	issuerUrl: string = LOCAL_SVID_ISSUER,
): JwtSvidIssuer {
	const kms = createInMemoryKms();
	kms.generateRsaKey(SVID_KEY_ID);
	return new JwtSvidIssuer({
		issuerUrl,
		kms,
		activeKeyId: SVID_KEY_ID,
		jwksKeyIds: [SVID_KEY_ID],
	});
}

/** `spiffe://hobo.local/agent/<id>` for an agent id that is not already a SPIFFE id. */
export function spiffeIdForAgent(
	agentId: string,
	trustDomain = "hobo.local",
): string {
	const id = agentId.replace(/^agent:/u, "").replace(/^spiffe:\/\//u, "");
	if (id.startsWith(`${trustDomain}/`)) return `spiffe://${id}`;
	return `spiffe://${trustDomain}/agent/${encodeURIComponent(id)}`;
}

/** Mints an SVID and verifies it against the issuer's own JWKS before returning it. */
async function mintVerifiedSvid(
	issuer: JwtSvidIssuer,
	input: Readonly<{
		spiffeId: string;
		audience: string;
		tenant: string;
		parent: PrincipalRef;
		ttlSeconds: number;
	}>,
) {
	const iat = Math.floor(Date.now() / 1000);
	const exp = iat + input.ttlSeconds;
	const token = await issuer.signJwtSvid({
		sub: input.spiffeId,
		aud: input.audience,
		tenant: input.tenant,
		parentPrincipal: { kind: input.parent.kind, id: input.parent.id },
		codeVersion: { digest: "", version: "" },
		scope: [],
		exp,
		nbf: iat,
		iat,
	});
	await verifyJwtWithJwks(token, issuer.jwks(), {
		issuer: issuer.issuerUrl,
		audience: input.audience,
		now: iat, // verifyJwtWithJwks compares seconds
	});
	return { token, exp };
}

const NO_REPLAY = { firstUse: async () => true };

/** Mints a DPoP proof and verifies it, so a broken proof never leaves the presenter. */
async function verifiedProof(
	key: Readonly<{ signer: Signer; publicJwk: PublicJwk }>,
	input: Readonly<{ htm: string; htu: string; accessToken: string }>,
): Promise<string> {
	const nowMs = Date.now();
	const proof = await mintDpopProof(key.signer, key.publicJwk, {
		...input,
		nowMs,
	});
	const verified = await verifyDpopProof({
		proof,
		...input,
		nowMs,
		replay: NO_REPLAY,
	});
	if (!verified.ok)
		throw new Error(
			`the presenter minted an invalid DPoP proof: ${verified.error.message}`,
		);
	return proof;
}

export function createCredentialPresenter(options?: {
	readonly agentPrincipal?: PrincipalRef;
	readonly humanPrincipal?: PrincipalRef;
	/** Inject DPoP key pair (tests). */
	readonly dpopKeyPair?: DpopKeyPair;
	/** Inject the SVID issuer; an in-memory RS256 issuer per issuer URL when absent. */
	readonly svidIssuer?: JwtSvidIssuer;
}): CredentialPresenter {
	const issuers = new Map<string, JwtSvidIssuer>();
	const issuerFor = (issuerUrl: string) => {
		if (options?.svidIssuer !== undefined) return options.svidIssuer;
		const existing = issuers.get(issuerUrl);
		if (existing !== undefined) return existing;
		const made = createLocalSvidIssuer(issuerUrl);
		issuers.set(issuerUrl, made);
		return made;
	};
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
				const tenant =
					env.HOBO_TENANT ?? profile?.session?.tenant ?? "hobo-dev";
				const svid = await mintVerifiedSvid(
					issuerFor(env.HOBO_SVID_ISSUER ?? LOCAL_SVID_ISSUER),
					{
						spiffeId,
						audience: input.audience,
						tenant,
						parent: human ?? agent,
						ttlSeconds: 900,
					},
				);
				const keyPair =
					options?.dpopKeyPair ??
					loadOrCreateDpopKeyPair(input.hoboHome, agent.id);
				const dpopProof = await verifiedProof(keyPair, {
					htm,
					htu: input.audience,
					accessToken: svid.token,
				});

				return {
					scheme: "dpop-bound",
					principal: { kind: "agent", id: agent.id },
					...(human !== null ? { humanPrincipal: human } : undefined),
					tenant,
					accessToken: svid.token,
					audience: input.audience,
					expiresAt: new Date(svid.exp * 1000).toISOString(),
					dpopProof,
					proofKeyId: keyPair.kid,
					metadata: {
						spiffeId,
						credentialScheme: "spiffe-jwt-svid+dpop",
						svidAlg: "RS256",
						dpopAlg: "ES256",
					},
				};
			}

			// The fleet authority's person token, DPoP-bound to the key `hobo fleet login` holds.
			if (env.HOBO_FLEET_AUTHORITY_URL) {
				const person = await readPerson(fleetHome(env));
				if (person !== undefined) {
					const dpopProof = await verifiedProof(person.key, {
						htm,
						htu: input.audience,
						accessToken: person.token,
					});
					return {
						scheme: "dpop-bound",
						principal: { kind: "user", id: person.principal },
						tenant: person.tenant,
						accessToken: person.token,
						audience: input.audience,
						expiresAt: person.expiresAt,
						dpopProof,
						proofKeyId: person.key.thumbprint,
						metadata: {
							credentialScheme: "fleet-person-token+dpop",
							dpopAlg: "ES256",
						},
					};
				}
			}

			if (profile?.session) {
				const session = profile.session;
				const keyPair =
					session.proofKeyId !== undefined
						? loadOrCreateDpopKeyPair(input.hoboHome, session.principal.id)
						: null;
				if (keyPair) {
					const dpopProof = await verifiedProof(keyPair, {
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
			const spiffeId = "spiffe://hobo.local/user/local-fixture";
			const tenant = env.HOBO_TENANT ?? "hobo-dev";
			const svid = await mintVerifiedSvid(issuerFor(LOCAL_SVID_ISSUER), {
				spiffeId,
				audience: input.audience,
				tenant,
				parent: principal,
				ttlSeconds: 3600,
			});
			const keyPair =
				options?.dpopKeyPair ??
				loadOrCreateDpopKeyPair(input.hoboHome, principal.id);
			const dpopProof = await verifiedProof(keyPair, {
				htm,
				htu: input.audience,
				accessToken: svid.token,
			});
			return {
				scheme: "local-fixture-svid",
				principal,
				tenant,
				accessToken: svid.token,
				audience: input.audience,
				expiresAt: new Date(svid.exp * 1000).toISOString(),
				dpopProof,
				proofKeyId: keyPair.kid,
				metadata: { fixture: "true", spiffeId },
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

function keyPairOf(privateKey: KeyObject): DpopKeyPair {
	const jwk = privateKey.export({ format: "jwk" });
	const publicJwk: PublicJwk = {
		kty: "EC",
		crv: "P-256",
		x: jwk.x ?? "",
		y: jwk.y ?? "",
	};
	return {
		kid: jwkThumbprint(publicJwk),
		publicJwk,
		signer: {
			keyId: parseKeyId(`${memberIdFromJwk(publicJwk)}#identity`),
			algorithm: KeyAlgorithm.ES256,
			async sign(bytes) {
				return new Uint8Array(
					sign("sha256", bytes, {
						key: privateKey,
						dsaEncoding: "ieee-p1363",
					}),
				);
			},
		},
	};
}

/** The stored private JWK of a DPoP key, when the file holds one. */
function storedKey(path: string): KeyObject | undefined {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		if (
			!isJsonObject(raw) ||
			raw.kty !== "EC" ||
			!isJsonString(raw.d) ||
			!isJsonString(raw.x) ||
			!isJsonString(raw.y)
		)
			return undefined;
		return createPrivateKey({
			key: { kty: "EC", crv: "P-256", x: raw.x, y: raw.y, d: raw.d },
			format: "jwk",
		});
	} catch {
		return undefined;
	}
}

export function loadOrCreateDpopKeyPair(
	hoboHome: string,
	principalId: string,
): DpopKeyPair {
	const path = dpopKeyPath(hoboHome, principalId);
	const existing = existsSync(path) ? storedKey(path) : undefined;
	if (existing !== undefined) return keyPairOf(existing);
	const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const keysDir = join(hoboHome, "keys");
	mkdirSync(keysDir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(keysDir, 0o700);
	} catch {
		// best-effort on platforms without chmod
	}
	writeFileSync(
		path,
		`${JSON.stringify(privateKey.export({ format: "jwk" }), null, 2)}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
	try {
		chmodSync(path, 0o600);
	} catch {
		// best-effort
	}
	return keyPairOf(privateKey);
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

/** @deprecated use mintDpopProof from @hobo/fleet/keys. A real, verified ES256 proof over a fresh key. */
export async function mintMockDpopProof(input: {
	readonly htm: string;
	readonly htu: string;
	readonly ath: string;
	readonly keyId: string;
}): Promise<string> {
	const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	return verifiedProof(keyPairOf(privateKey), {
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
