/**
 * The authority's `CredentialIssuer` (§6.6) over @hobo/identity: RS256 JWTs
 * signed through `JwtSvidIssuer` with the token-signing ring that
 * `loadSecretStoreKms` holds. Member tokens (JWT-SVIDs) and person tokens are
 * bound to a key by `cnf.jkt` and carry the authority incarnation; `verify`
 * accepts only tokens signed by a key of this ring, for this issuer, of the
 * current incarnation or later (a token from before a restore is refused).
 *
 * The signing key is the ring's active key: `activeKeyId()` when the ring
 * offers it (amendment 2), else the lowest-numbered `<prefix>#<n>` key that
 * still signs (a retired key refuses to sign). The JWKS lists every key the
 * ring still holds, so tokens signed before a rotation verify until they
 * expire. The ring is read through `kms()`, so a reloaded ring takes effect
 * at once.
 */
import { createPublicKey, createVerify, randomBytes } from "node:crypto";
import {
	type JsonObject,
	type JsonValue,
	type PrincipalRef,
	parseTenantId,
	type TenantId,
} from "@hobo/core";
import {
	type Clock,
	type CredentialIssuer,
	type FleetFailure,
	type Outcome,
	parseMemberId,
	type VerifiedToken,
} from "@hobo/fleet";
import { JwtSvidIssuer, type KmsLike } from "@hobo/identity";

const MEMBER_KIND = "member";
const PERSON_KIND = "person";
const ALLOWED_SKEW_S = 60;
/** How many `<prefix>#<n>` key ids are probed when the ring cannot list them. */
const MAX_RING_PROBE = 64;
const ALGORITHM = "RS256";

export type IssuerOptions = Readonly<{
	issuerUrl: string;
	/** The ring's secret name, `<secretPrefix>/token-signing`: key ids are `<prefix>#<n>`. */
	prefix: string;
	kms: () => KmsLike;
	incarnation: () => number;
	now: Clock;
}>;

function denied(message: string): Outcome<VerifiedToken> {
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
function texts(value: JsonValue | undefined): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: string[] = [];
	for (const item of value) {
		if (!isText(item)) return undefined;
		out.push(item);
	}
	return out;
}

function decodeSegment(segment: string): JsonValue | undefined {
	try {
		const parsed: JsonValue = JSON.parse(
			Buffer.from(segment, "base64url").toString("utf8"),
		);
		return parsed;
	} catch {
		return undefined;
	}
}

function principalOf(kind: string, id: string): PrincipalRef | undefined {
	return kind === "user" ||
		kind === "agent" ||
		kind === "service" ||
		kind === "system"
		? { kind, id }
		: undefined;
}

function tenantOf(value: JsonValue | undefined): TenantId | undefined {
	if (!isText(value)) return undefined;
	try {
		return parseTenantId(value);
	} catch {
		return undefined;
	}
}

/** Every key id the ring holds, lowest number first. */
export function ringKeyIds(kms: KmsLike, prefix: string): readonly string[] {
	const listed = kms.keyIds?.();
	if (listed !== undefined) return [...listed].filter((kid) => kms.hasKey(kid));
	const held: string[] = [];
	for (let n = 1; n <= MAX_RING_PROBE; n += 1) {
		const kid = `${prefix}#${n}`;
		if (kms.hasKey(kid)) held.push(kid);
	}
	return held;
}

/** The key new tokens are signed with (carry-forward rule 3 of L27). */
export function activeKeyId(kms: KmsLike, prefix: string): string | undefined {
	const active = kms.activeKeyId?.();
	if (active !== undefined && kms.hasKey(active)) return active;
	for (const kid of ringKeyIds(kms, prefix)) {
		try {
			kms.sign(kid, "");
			return kid;
		} catch {
			// Retired: verifies, no longer signs.
		}
	}
	return undefined;
}

export function createJwtCredentialIssuer(
	options: IssuerOptions,
): CredentialIssuer {
	const issuerUrl = options.issuerUrl.replace(/\/+$/u, "");

	const signer = (): JwtSvidIssuer => {
		const kms = options.kms();
		const active = activeKeyId(kms, options.prefix);
		if (active === undefined)
			throw new Error("the token-signing ring holds no key that signs");
		return new JwtSvidIssuer({
			issuerUrl,
			kms,
			activeKeyId: active,
			jwksKeyIds: ringKeyIds(kms, options.prefix),
		});
	};

	const mint = async (
		subject: string,
		audiences: readonly string[],
		extra: JsonObject,
		ttlMs: number,
	) => {
		const issuedAtMs = options.now();
		const iat = Math.floor(issuedAtMs / 1000);
		const exp = Math.floor((issuedAtMs + ttlMs) / 1000);
		const tenant = extra.tenant;
		const claims = {
			sub: subject,
			aud: [...audiences],
			tenant: isText(tenant) ? tenant : "",
			parentPrincipal: { kind: "service", id: "hobo-fleet-authority" },
			codeVersion: { digest: "", version: "" },
			scope: [],
			iat,
			nbf: iat,
			exp,
			jti: randomBytes(16).toString("base64url"),
			incarnation: options.incarnation(),
			...extra,
		};
		const token = await signer().signJwtSvid(claims);
		return { token, expiresAtMs: exp * 1000 };
	};

	return {
		issueMember(input) {
			return mint(
				input.member.memberId,
				input.audiences,
				{
					kind: MEMBER_KIND,
					tenant: input.member.tenant,
					fleets: input.member.memberships.map((m) => m.fleet),
					cnf: { jkt: input.jkt },
				},
				input.ttlMs,
			);
		},
		issuePerson(input) {
			return mint(
				`${input.principal.kind}:${input.principal.id}`,
				[issuerUrl],
				{
					kind: PERSON_KIND,
					tenant: input.tenant,
					principal_kind: input.principal.kind,
					principal_id: input.principal.id,
					tags: [...input.tags],
					cnf: { jkt: input.jkt },
				},
				input.ttlMs,
			);
		},
		verify(token, audience, nowMs) {
			const parts = token.split(".");
			if (parts.length !== 3) return denied("the token is not a compact JWS");
			const [head, body, signature] = parts;
			const header = decodeSegment(head ?? "");
			const claims = decodeSegment(body ?? "");
			if (!isRecord(header) || !isRecord(claims))
				return denied("the token does not decode");
			if (header.alg !== ALGORITHM || !isText(header.kid))
				return denied("the token is not signed by this issuer");
			const kms = options.kms();
			if (!ringKeyIds(kms, options.prefix).includes(header.kid))
				return denied("the token is not signed by this issuer");
			let valid = false;
			try {
				valid = createVerify("RSA-SHA256")
					.update(`${head}.${body}`)
					.end()
					.verify(
						createPublicKey({ key: kms.publicJwk(header.kid), format: "jwk" }),
						Buffer.from(signature ?? "", "base64url"),
					);
			} catch {
				valid = false;
			}
			if (!valid) return denied("the token signature does not verify");
			if (claims.iss !== issuerUrl)
				return denied("the token has another issuer");
			const { exp, iat, cnf, incarnation } = claims;
			if (!isCount(exp) || !isCount(iat))
				return denied("the token has no exp or iat");
			if (exp * 1000 <= nowMs) return denied("the token has expired");
			if (iat - ALLOWED_SKEW_S > nowMs / 1000)
				return denied("the token was issued in the future");
			if (!isCount(incarnation) || incarnation < options.incarnation())
				return {
					ok: false,
					error: {
						code: "incarnation-stale",
						message: "the token is from before a restore",
					},
				};
			const jkt = isRecord(cnf) ? cnf.jkt : undefined;
			if (!isText(jkt) || jkt.length === 0)
				return denied("the token is not bound to a key");
			const tenant = tenantOf(claims.tenant);
			if (tenant === undefined) return denied("the token names no tenant");
			const audiences = texts(claims.aud);
			const expiresAtMs = exp * 1000;
			if (claims.kind === MEMBER_KIND) {
				if (audiences === undefined || !audiences.includes(audience))
					return denied(`the token is not for ${audience}`);
				if (!isText(claims.sub)) return denied("the token has no subject");
				try {
					return {
						ok: true,
						value: {
							kind: "member",
							memberId: parseMemberId(claims.sub, "sub"),
							tenant,
							jkt,
							expiresAtMs,
						},
					};
				} catch {
					return denied("the token subject is not a member id");
				}
			}
			if (claims.kind === PERSON_KIND) {
				if (audiences === undefined || !audiences.includes(issuerUrl))
					return denied("the person token is not for this authority");
				const tags = texts(claims.tags);
				const kind = claims.principal_kind;
				const id = claims.principal_id;
				const principal =
					isText(kind) && isText(id) ? principalOf(kind, id) : undefined;
				if (tags === undefined || principal === undefined)
					return denied("the person token has no principal or tags");
				return {
					ok: true,
					value: { kind: "person", principal, tenant, tags, jkt, expiresAtMs },
				};
			}
			return denied("the token is neither a member nor a person token");
		},
		jwks() {
			return JSON.stringify(signer().jwks());
		},
	};
}
