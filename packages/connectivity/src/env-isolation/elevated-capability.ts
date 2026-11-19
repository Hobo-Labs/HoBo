import { createHash, randomBytes } from "node:crypto";

import { mintJwtSvid, verifyJwtSvid } from "../crypto/jwt-svid.js";
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

export type MintElevatedInput = Readonly<{
	subject: string;
	isolationClass: IsolationClass;
	audience?: string;
	priorAuthnClass?: IsolationClass;
	issuedBy: string;
	ttlSeconds?: number;
	obligations?: readonly string[];
	evidence: Readonly<{
		kind: "lower-env-authn" | "step-up-mfa" | "dual-approval" | "break-glass";
		ref: string;
	}>;
	hmacSecret?: string;
	allowDefaultSecret?: boolean;
	now?: string;
}>;

export type VerifiedElevatedAccess = Readonly<{
	ok: true;
	capability: ElevatedAccessCapability;
	tokenClaims: Readonly<{ sub: string; aud: readonly string[]; exp: number }>;
}>;

export function mintElevatedAccessCapability(
	input: MintElevatedInput,
	options?: {
		readonly tenant?: string;
		readonly events?: AccessEvent[];
	},
) {
	const t = input.now ?? new Date().toISOString();
	const ttl = input.ttlSeconds ?? ELEVATED_CAPABILITY_TTL_SECONDS;
	const audience = input.audience ?? `${input.isolationClass}-access`;
	const id = `elev_${randomBytes(8).toString("hex")}`;
	const spiffeId = input.subject.startsWith("spiffe://")
		? input.subject
		: `spiffe://yard/${input.subject}`;

	const minted = mintJwtSvid({
		spiffeId,
		audience: [audience, `env:${input.isolationClass}`],
		ttlSeconds: ttl,
		issuer: "hobo:elevated-access",
		now: Math.floor(Date.parse(t) / 1000),
		...(input.hmacSecret !== undefined
			? { hmacSecret: input.hmacSecret }
			: undefined),
		allowDefaultSecret: input.allowDefaultSecret ?? true,
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
		obligations: Object.freeze([
			...(input.obligations ?? ["short-lived", "audience-bound", "audit"]),
			`evidence:${input.evidence.kind}`,
		]),
		tokenRef,
	});

	const event = createAccessEvent({
		type: ACCESS_EVENTS.ElevatedMinted,
		tenant: options?.tenant ?? "local",
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
				.update(minted.token)
				.digest("hex")
				.slice(0, 16),
		},
	});
	options?.events?.push(event);

	return { capability, token: minted.token, event };
}

export function verifyElevatedAccessCapability(input: {
	readonly token: string;
	readonly expectedAudience: string;
	readonly expectedIsolationClass: IsolationClass;
	readonly hmacSecret?: string;
	readonly allowDefaultSecret?: boolean;
	readonly now?: string;
}): VerifiedElevatedAccess | { ok: false; code: string; reason: string } {
	try {
		const claims = verifyJwtSvid({
			token: input.token,
			audience: input.expectedAudience,
			hmacSecret: input.hmacSecret ?? "hobo-local-svid-dev-only",
			...(input.now !== undefined
				? { now: Math.floor(Date.parse(input.now) / 1000) }
				: undefined),
		});
		const envAud = `env:${input.expectedIsolationClass}`;
		const aud = Array.isArray(claims.aud) ? claims.aud : [String(claims.aud)];
		if (!aud.includes(envAud)) {
			return {
				ok: false,
				code: "elevated-wrong-env",
				reason: `token missing audience ${envAud}`,
			};
		}
		const nowIso = input.now ?? new Date().toISOString();
		const expiresAt = new Date(claims.exp * 1000).toISOString();
		if (isExpired(expiresAt, nowIso)) {
			return {
				ok: false,
				code: "elevated-expired",
				reason: "elevated capability expired",
			};
		}

		const capability: ElevatedAccessCapability = Object.freeze({
			schemaVersion: ELEVATED_ACCESS_SCHEMA,
			id: claims.jti ?? "unknown",
			subject: claims.sub,
			audience: input.expectedAudience,
			isolationClass: input.expectedIsolationClass,
			issuedAt: new Date(claims.iat * 1000).toISOString(),
			expiresAt,
			obligations: Object.freeze(["short-lived", "audience-bound"]),
			tokenRef: `tokenref://elevated/${claims.jti ?? "unknown"}`,
		});

		return {
			ok: true,
			capability,
			tokenClaims: {
				sub: claims.sub,
				aud,
				exp: claims.exp,
			},
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			code: "elevated-invalid",
			reason: message,
		};
	}
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
