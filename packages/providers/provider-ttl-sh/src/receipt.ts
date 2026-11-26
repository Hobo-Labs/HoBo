/**
 * Receipts and facts — the serialized outputs that leave this package.
 *
 * These are the artifacts that end up in a plan, an event log, and a support
 * bundle, so they are built by projection from the push record rather than by
 * spreading it: a spread quietly republishes whatever a future field holds.
 * {@link assertNoCredentialMaterial} then re-checks the result.
 *
 * The scan has one deliberate exception, and it is the interesting design
 * decision in this file. A sha256 digest is 64 unbroken hex characters, which
 * is exactly the shape of the structural "long opaque blob" rule that catches
 * prefix-less tokens. A digest is not a secret — it is the artifact's identity
 * and the only thing that makes the receipt verifiable — so digests and
 * content-addressed names are masked out before the credential rules run, and
 * everything else that long is still refused.
 */
import type {
	BootstrapClass,
	GuestLease,
	GuestLeaseCleanupPolicy,
	OwnershipTransitionMode,
} from "@hobo/claims";

import {
	TTL_SH_BINDING_PROFILE_REFS,
	TTL_SH_BOOTSTRAP_CLASS,
	TTL_SH_BOOTSTRAP_STRATEGY_REF,
	TTL_SH_CLAIM_ACTION_COUNT,
	TTL_SH_CLAIM_MODE,
	TTL_SH_CLEANUP_POLICY,
	TTL_SH_OWNERSHIP_TRANSITION_MODE,
} from "./definition.js";
import { TtlShProviderError } from "./errors.js";
import { type JsonValue, parseJsonValue } from "./json.js";
import type { TtlShPushRecord } from "./push.js";
import type { TtlShNameKind } from "./reference.js";

// domain-view: the receipt is the projection that leaves the package — computed expiry, flattened claim facts, no live reference object; the proto message is its wire form.
export type TtlShProvisionReceipt = {
	readonly schemaVersion: "hobo.provider-ttl-sh.receipt/v1";
	readonly definitionId: string;
	readonly providerId: string;
	readonly resourceRef: string;
	/** What a host is handed: `ttl.sh/<name>:<ttl>`. */
	readonly pullReference: string;
	readonly registryHost: string;
	readonly artifactName: string;
	readonly nameKind: TtlShNameKind;
	readonly digest: string;
	readonly sizeBytes: number;
	readonly ttl: {
		readonly text: string;
		readonly minutes: number;
	};
	readonly pushedAtMs: number;
	readonly expiresAtMs: number;
	readonly expiresAtIso: string;
	/** Local arithmetic over the requested TTL. ttl.sh reports no expiry. */
	readonly expirySource: "computed-from-ttl";
	readonly adopted: boolean;
	readonly bootstrapClass: BootstrapClass;
	readonly claim: {
		readonly mode: typeof TTL_SH_CLAIM_MODE;
		readonly ownershipTransitionMode: OwnershipTransitionMode;
		readonly actionCount: number;
		/** Always empty. There is no ceremony, so there are no actions. */
		readonly actions: readonly string[];
	};
	readonly cleanupPolicy: GuestLeaseCleanupPolicy;
	readonly teardown: "expiry-only";
	/** Anyone holding the reference can pull it. Stated, not implied. */
	readonly visibility: "public-unauthenticated";
	readonly bindingProfiles: readonly string[];
	readonly migrationProfiles: readonly string[];
};

export type TtlShFactKind =
	| "provider.ttl-sh.artifact.pushed"
	| "provider.ttl-sh.artifact.adopted"
	| "provider.ttl-sh.lease.expired"
	/**
	 * A digest-identical copy now exists in a registry somebody is responsible
	 * for. Not an ownership change here — the ephemeral copy keeps expiring on
	 * schedule — which is why the fact names the artifact rather than the lease.
	 */
	| "provider.ttl-sh.artifact.promoted";

// domain-view: the emitted fact adds the occurrence instant and a flattened detail map; the proto message is its wire form.
export type TtlShProviderFact = {
	readonly kind: TtlShFactKind;
	readonly occurredAtMs: number;
	readonly resourceRef: string;
	readonly pullReference: string;
	readonly digest: string;
	readonly detail: Readonly<Record<string, string | number | boolean>>;
};

/** Non-secret shapes masked out before the credential rules run. */
const PRESERVED: readonly RegExp[] = [
	/sha256:[0-9a-f]{64}/gu,
	/sha256-[0-9a-f]{64}/gu,
];

const FORBIDDEN: readonly {
	readonly name: string;
	readonly pattern: RegExp;
}[] = [
	{ name: "bearer-token", pattern: /Bearer\s+\S+/iu },
	{ name: "basic-auth", pattern: /Basic\s+[A-Za-z0-9+/=]{8,}/u },
	{
		name: "token-assignment",
		pattern:
			/\b(?:token|password|passwd|pwd|secret|auth)\s*[=:]\s*"?[^\s"',}]{8,}/iu,
	},
	{ name: "registry-auth-header", pattern: /x-registry-auth\s*[=:]/iu },
	// Written to survive JSON escaping: a docker config nested inside a
	// serialized field arrives as `\"auths\":`, not as `"auths":`.
	{ name: "docker-config-auths", pattern: /\bauths\\?"?\s*:/iu },
	{ name: "userinfo-pair", pattern: /\/\/[^/\s:@]+:[^/\s:@]+@/u },
	{ name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
	{ name: "jwt", pattern: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./u },
	{ name: "opaque-blob", pattern: /[A-Za-z0-9_-]{40,}/u },
];

export type CredentialScanHit = {
	readonly rule: string;
	readonly excerpt: string;
};

function jsonView(
	value:
		| JsonValue
		| TtlShProvisionReceipt
		| TtlShProviderFact
		| readonly TtlShProviderFact[]
		| GuestLease,
): JsonValue {
	return parseJsonValue(JSON.stringify(value));
}

/** Scan any JSON-serializable value for credential material. */
export function scanForCredentialMaterial(
	value: JsonValue,
): readonly CredentialScanHit[] {
	let serialized = JSON.stringify(value) ?? "";
	for (const pattern of PRESERVED)
		serialized = serialized.replace(pattern, "sha256");
	const hits: CredentialScanHit[] = [];
	for (const rule of FORBIDDEN) {
		const match = rule.pattern.exec(serialized);
		if (match === null) continue;
		const start = Math.max(0, match.index - 12);
		hits.push({
			rule: rule.name,
			// Eight characters is enough to locate the field and not enough
			// to be a usable credential.
			excerpt: `…${serialized.slice(start, match.index + 8).replace(/[^\x20-\x7e]/gu, " ")}…`,
		});
	}
	return hits;
}

export function assertNoCredentialMaterial(
	value: JsonValue,
	what: string,
): void {
	const hits = scanForCredentialMaterial(value);
	if (hits.length === 0) return;
	throw new TtlShProviderError(
		"CREDENTIAL_REFUSED",
		`${what} contains credential-shaped material (${hits.map((hit) => hit.rule).join(", ")}) and was not emitted`,
	);
}

export function toProvisionReceipt(
	record: TtlShPushRecord,
): TtlShProvisionReceipt {
	const receipt: TtlShProvisionReceipt = {
		schemaVersion: "hobo.provider-ttl-sh.receipt/v1",
		definitionId: record.definitionId,
		providerId: record.providerId,
		resourceRef: record.resourceRef,
		pullReference: record.reference.pullReference,
		registryHost: record.reference.host,
		artifactName: record.reference.name,
		nameKind: record.reference.nameKind,
		digest: record.digest,
		sizeBytes: record.sizeBytes,
		ttl: {
			text: record.reference.ttl.text,
			minutes: record.reference.ttl.minutes,
		},
		pushedAtMs: record.pushedAtMs,
		expiresAtMs: record.expiresAtMs,
		expiresAtIso: new Date(record.expiresAtMs).toISOString(),
		expirySource: record.expirySource,
		adopted: record.adopted,
		bootstrapClass: TTL_SH_BOOTSTRAP_CLASS,
		claim: {
			mode: TTL_SH_CLAIM_MODE,
			ownershipTransitionMode: TTL_SH_OWNERSHIP_TRANSITION_MODE,
			actionCount: TTL_SH_CLAIM_ACTION_COUNT,
			actions: [],
		},
		cleanupPolicy: TTL_SH_CLEANUP_POLICY,
		teardown: "expiry-only",
		visibility: "public-unauthenticated",
		bindingProfiles: [...TTL_SH_BINDING_PROFILE_REFS],
		migrationProfiles: [],
	};
	assertNoCredentialMaterial(jsonView(receipt), "the ttl.sh provision receipt");
	return receipt;
}

export function toProviderFacts(
	record: TtlShPushRecord,
	nowMs: number = record.pushedAtMs,
): readonly TtlShProviderFact[] {
	const base = {
		occurredAtMs: record.pushedAtMs,
		resourceRef: record.resourceRef,
		pullReference: record.reference.pullReference,
		digest: record.digest,
	};
	const facts: TtlShProviderFact[] = [
		{
			...base,
			kind: record.adopted
				? "provider.ttl-sh.artifact.adopted"
				: "provider.ttl-sh.artifact.pushed",
			detail: {
				ttl: record.reference.ttl.text,
				expiresAtIso: new Date(record.expiresAtMs).toISOString(),
				expirySource: record.expirySource,
				nameKind: record.reference.nameKind,
				sizeBytes: record.sizeBytes,
			},
		},
	];
	if (record.expiresAtMs <= nowMs) {
		facts.push({
			...base,
			occurredAtMs: record.expiresAtMs,
			kind: "provider.ttl-sh.lease.expired",
			detail: {
				reason:
					"the registry deletes an artifact at its TTL; the pull reference no longer resolves",
			},
		});
	}
	assertNoCredentialMaterial(jsonView(facts), "the ttl.sh provider facts");
	return facts;
}

/**
 * Project a receipt into the durable guest-lease record `@hobo/claims` owns.
 *
 * This is what makes a push visible to the claim coordinator as a lease that
 * ends on its own rather than as a resource waiting to be claimed: no claim
 * deadline, no renewals, and `retain-until-provider-expiry` cleanup, because
 * there is nothing HoBo can delete.
 */
export function toGuestLease(
	receipt: TtlShProvisionReceipt,
	input: {
		readonly leaseId: string;
		readonly subjectRef: string;
		readonly fencingToken: string;
	},
): GuestLease {
	const lease: GuestLease = {
		schemaVersion: "hobo.guest-lease/v1",
		id: input.leaseId,
		subjectRef: input.subjectRef,
		bootstrapStrategyRef: TTL_SH_BOOTSTRAP_STRATEGY_REF,
		bootstrapClass: receipt.bootstrapClass,
		createdAt: receipt.pushedAtMs,
		expiresAt: receipt.expiresAtMs,
		// No `claimBy`: there is no claim window, because there is no claim.
		renewable: false,
		renewalCount: 0,
		cleanupPolicy: receipt.cleanupPolicy,
		status: "active",
		fencingToken: input.fencingToken,
	};
	assertNoCredentialMaterial(jsonView(lease), "the ttl.sh guest lease");
	return lease;
}
