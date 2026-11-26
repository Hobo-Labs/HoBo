/**
 * Dual-adapter verification + dual-audience bridge tokens (ADR-0100 grace reuse).
 * Scope never widens. Fail-closed on critical claim divergence.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";

import { applyClaimTransform, type MappingSpec } from "./mapping-spec.js";

export type AdapterClaims = Readonly<Record<string, string>>;

export type DualVerifyResult =
	| Readonly<{
			ok: true;
			principalRef: string;
			sourceSubject: string;
			targetSubject: string;
			mappedClaims: Readonly<Record<string, string>>;
	  }>
	| Readonly<{
			ok: false;
			code: string;
			reason: string;
			divergedClaims: readonly string[];
	  }>;

export type DualAudienceGrant = Readonly<{
	grantId: string;
	principalRef: string;
	audiences: readonly string[];
	tokenRef: string;
	/** Short-lived dual-audience material — broker-internal only. */
	material: string;
	expiresAt: string;
	/** Scope preserved or narrowed; never widened. */
	scope: Readonly<{ port: string; resource: string; action: string }>;
	sourceAdapter: string;
	targetAdapter: string;
}>;

/**
 * Verify source + target claim sets under MappingSpec.
 * Critical claims must match after transform; non-critical may drift when allowed.
 */
export function dualVerifyClaims(input: {
	readonly mapping: MappingSpec;
	readonly sourceClaims: AdapterClaims;
	readonly targetClaims: AdapterClaims;
	readonly tenant: string;
}): DualVerifyResult {
	const diverged: string[] = [];
	const mapped: Record<string, string> = {};

	for (const m of input.mapping.claimMappings) {
		const rawSource = input.sourceClaims[m.from];
		const rawTarget = input.targetClaims[m.to] ?? input.targetClaims[m.from];
		if (rawSource === undefined || rawTarget === undefined) {
			if (m.critical) {
				return {
					ok: false,
					code: "dual-claim-missing",
					reason: `critical claim missing: ${m.from}→${m.to}`,
					divergedClaims: Object.freeze([m.from]),
				};
			}
			continue;
		}
		const src = applyClaimTransform(rawSource, m.transform);
		const tgt = applyClaimTransform(rawTarget, m.transform);
		if (src !== tgt) {
			if (m.critical || !input.mapping.allowNonCriticalDrift) {
				diverged.push(m.from);
			}
		} else {
			mapped[m.to] = src;
		}
	}

	if (diverged.length > 0) {
		return {
			ok: false,
			code: "dual-consistency-failed",
			reason: `critical dual claims diverged: ${diverged.join(",")}`,
			divergedClaims: Object.freeze(diverged),
		};
	}

	const subjectRaw =
		input.sourceClaims[input.mapping.principalSubjectClaim] ??
		input.sourceClaims.sub;
	if (!subjectRaw) {
		return {
			ok: false,
			code: "dual-principal-missing",
			reason: "principal subject claim missing on source",
			divergedClaims: Object.freeze([input.mapping.principalSubjectClaim]),
		};
	}

	const principalRef = `principal:${input.tenant}:${applyClaimTransform(subjectRaw, "principal-ref")}`;
	return {
		ok: true,
		principalRef,
		sourceSubject: `adapter://${input.mapping.sourceAdapter}/${subjectRaw}`,
		targetSubject: `adapter://${input.mapping.targetAdapter}/${input.targetClaims[input.mapping.principalSubjectClaim] ?? subjectRaw}`,
		mappedClaims: Object.freeze(mapped),
	};
}

/**
 * Mint dual-audience bridge grant (broker-internal). Both audiences valid until cutover.
 * Reuses ADR-0100 short-lived grace discipline (default 15m).
 */
export function mintDualAudienceGrant(input: {
	readonly principalRef: string;
	readonly sourceAdapter: string;
	readonly targetAdapter: string;
	readonly scope: Readonly<{ port: string; resource: string; action: string }>;
	readonly vaultRoot: string;
	readonly ttlSeconds?: number;
	readonly now?: () => string;
}): DualAudienceGrant {
	const now = input.now ?? (() => new Date().toISOString());
	const ttl = input.ttlSeconds ?? 900;
	const t = now();
	const grantId = `dual_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
	const audiences = Object.freeze([
		`hobo:adapter:${input.sourceAdapter}`,
		`hobo:adapter:${input.targetAdapter}`,
	]);
	const material = createHmac("sha256", input.vaultRoot)
		.update(`${grantId}:${input.principalRef}:${audiences.join(",")}`)
		.digest("base64url");
	const tokenRef = `tokenref://dual/${grantId}`;
	return Object.freeze({
		grantId,
		principalRef: input.principalRef,
		audiences,
		tokenRef,
		material,
		expiresAt: new Date(Date.parse(t) + ttl * 1000).toISOString(),
		scope: Object.freeze({ ...input.scope }),
		sourceAdapter: input.sourceAdapter,
		targetAdapter: input.targetAdapter,
	});
}

export interface DualGrantVerification {
	readonly ok: boolean;
	readonly code?: string;
}

/**
 * Verify dual-audience material without exposing it in return value for agent paths.
 */
export function verifyDualAudienceGrant(input: {
	readonly grant: DualAudienceGrant;
	readonly vaultRoot: string;
	readonly now?: string;
}): DualGrantVerification {
	const now = input.now ?? new Date().toISOString();
	if (Date.parse(now) >= Date.parse(input.grant.expiresAt)) {
		return { ok: false, code: "dual-grant-expired" };
	}
	const expected = createHmac("sha256", input.vaultRoot)
		.update(
			`${input.grant.grantId}:${input.grant.principalRef}:${input.grant.audiences.join(",")}`,
		)
		.digest("base64url");
	if (expected !== input.grant.material) {
		return { ok: false, code: "dual-grant-invalid" };
	}
	return { ok: true };
}

/** Opaque rebind hint for agents after identity.Migrated (no secrets). */
export function agentRebindHint(principalRef: string): Readonly<{
	principalRef: string;
	action: "re-attest-svid";
	reason: "identity-migrated";
}> {
	return Object.freeze({
		principalRef,
		action: "re-attest-svid" as const,
		reason: "identity-migrated" as const,
	});
}

export function dualConsistencyDigest(
	results: readonly DualVerifyResult[],
): `sha256:${string}` {
	const payload = results
		.map((r) => {
			if (r.ok === true) return `ok:${r.principalRef}`;
			return `fail:${r.code}:${r.divergedClaims.join(",")}`;
		})
		.join("|");
	return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}
