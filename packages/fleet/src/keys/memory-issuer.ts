// `createMemoryCredentialIssuer`: ES256 JWTs over an in-memory key, through
// the same JOSE code as DPoP (./jose.ts). For tests, `createTestAuthority` and
// offline development; the authority's issuer is `@hobo/identity`'s.
//
// Member tokens (JWT-SVIDs) carry `aud` and are verified against it. Person
// tokens are only presented to the authority that issued them, so they carry
// no `aud` and `verify` checks the issuer, key, expiry and kind instead. Both
// are bound to a key by `cnf.jkt` (RFC 9449 §6); checking the DPoP proof
// against that thumbprint is the caller's job.
import { randomBytes } from "node:crypto";
import {
	type JsonObject,
	type PrincipalRef,
	parseTenantId,
	type TenantId,
} from "@hobo/core";
import { KeyAlgorithm, type MemberRecord } from "../_generated/fleet_pb.js";
import { parseKeyId, parseMemberId } from "../ids.js";
import type {
	Clock,
	CredentialIssuer,
	FleetFailure,
	Outcome,
	VerifiedToken,
} from "../ports.js";
import {
	decodeCompactJws,
	publicJwkJson,
	signCompactJws,
	thumbprintOf,
	verifyCompactJws,
} from "./jose.js";
import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
} from "./json.js";
import { generateSigningKey, memorySigner } from "./signers.js";

const ISSUER = "urn:hobo:fleet:memory-issuer";
const MEMBER_KIND = "member";
const PERSON_KIND = "person";
const ALLOWED_IAT_SKEW_S = 60;

function denied(message: string): Outcome<VerifiedToken> {
	const error: FleetFailure = { code: "unauthenticated", message };
	return { ok: false, error };
}

function strings(value: JsonObject[string] | undefined): string[] | undefined {
	if (!isJsonArray(value)) return undefined;
	const out: string[] = [];
	for (const item of value) {
		if (!isJsonString(item)) return undefined;
		out.push(item);
	}
	return out;
}

function principalOf(kind: string, id: string): PrincipalRef | undefined {
	return kind === "user" ||
		kind === "agent" ||
		kind === "service" ||
		kind === "system"
		? { kind, id }
		: undefined;
}

function tenantOf(value: JsonObject[string] | undefined): TenantId | undefined {
	if (!isJsonString(value)) return undefined;
	try {
		return parseTenantId(value);
	} catch {
		return undefined;
	}
}

export function memoryCredentialIssuer(now: Clock): CredentialIssuer {
	const { privateKey, publicJwk } = generateSigningKey(KeyAlgorithm.ES256);
	const kid = thumbprintOf(publicJwk);
	// The key id of a Signer names a fleet key; this one is never published as such (the JWT `kid` is the thumbprint).
	const signer = memorySigner(parseKeyId("authority#0"), privateKey);
	const header: JsonObject = { alg: "ES256", typ: "JWT", kid };

	const mint = async (claims: JsonObject, ttlMs: number) => {
		const issuedAtMs = now();
		const expiresAtMs = issuedAtMs + ttlMs;
		const token = await signCompactJws(
			header,
			{
				...claims,
				iss: ISSUER,
				iat: Math.floor(issuedAtMs / 1000),
				exp: Math.floor(expiresAtMs / 1000),
				jti: randomBytes(16).toString("base64url"),
			},
			signer,
		);
		return Object.freeze({
			token,
			expiresAtMs: Math.floor(expiresAtMs / 1000) * 1000,
		});
	};

	return Object.freeze({
		issueMember(input: Parameters<CredentialIssuer["issueMember"]>[0]) {
			const member: MemberRecord = input.member;
			return mint(
				{
					kind: MEMBER_KIND,
					sub: member.memberId,
					tenant: member.tenant,
					aud: [...input.audiences],
					fleets: member.memberships.map((membership) => membership.fleet),
					cnf: { jkt: input.jkt },
				},
				input.ttlMs,
			);
		},
		issuePerson(input: Parameters<CredentialIssuer["issuePerson"]>[0]) {
			return mint(
				{
					kind: PERSON_KIND,
					sub: `${input.principal.kind}:${input.principal.id}`,
					principal_kind: input.principal.kind,
					principal_id: input.principal.id,
					tenant: input.tenant,
					tags: [...input.tags],
					cnf: { jkt: input.jkt },
				},
				input.ttlMs,
			);
		},
		verify(token: string, audience: string, nowMs: number) {
			const decoded = decodeCompactJws(token);
			if (decoded === undefined)
				return denied("the token is not a compact JWS");
			if (decoded.header.alg !== "ES256" || decoded.header.kid !== kid)
				return denied("the token is not signed by this issuer");
			if (!verifyCompactJws(decoded, publicJwk))
				return denied("the token signature does not verify");
			const claims = decoded.payload;
			if (claims.iss !== ISSUER) return denied("the token has another issuer");
			const { exp, iat, cnf } = claims;
			if (!isJsonNumber(exp) || !isJsonNumber(iat))
				return denied("the token has no exp or iat");
			if (exp * 1000 <= nowMs) return denied("the token has expired");
			if (iat - ALLOWED_IAT_SKEW_S > nowMs / 1000)
				return denied("the token was issued in the future");
			const jkt = isJsonObject(cnf) ? cnf.jkt : undefined;
			if (!isJsonString(jkt) || jkt.length === 0)
				return denied("the token is not bound to a key");
			const tenant = tenantOf(claims.tenant);
			if (tenant === undefined) return denied("the token names no tenant");
			const expiresAtMs = exp * 1000;
			if (claims.kind === MEMBER_KIND) {
				const audiences = strings(claims.aud);
				if (audiences === undefined || !audiences.includes(audience))
					return denied(`the token is not for ${audience}`);
				if (!isJsonString(claims.sub))
					return denied("the token has no subject");
				try {
					const memberId = parseMemberId(claims.sub, "sub");
					return {
						ok: true,
						value: Object.freeze({
							kind: "member",
							memberId,
							tenant,
							jkt,
							expiresAtMs,
						}),
					};
				} catch {
					return denied("the token subject is not a member id");
				}
			}
			if (claims.kind === PERSON_KIND) {
				const tags = strings(claims.tags);
				const { principal_kind: kind, principal_id: id } = claims;
				const principal =
					isJsonString(kind) && isJsonString(id)
						? principalOf(kind, id)
						: undefined;
				if (tags === undefined || principal === undefined)
					return denied("the person token has no principal or tags");
				return {
					ok: true,
					value: Object.freeze({
						kind: "person",
						principal,
						tenant,
						tags: Object.freeze(tags),
						jkt,
						expiresAtMs,
					}),
				};
			}
			return denied("the token is neither a member nor a person token");
		},
		jwks() {
			return JSON.stringify({
				keys: [{ ...publicJwkJson(publicJwk), kid, alg: "ES256", use: "sig" }],
			});
		},
	} satisfies CredentialIssuer);
}
