import { parseSecretRef } from "@hobo/bindings";
import {
	type ClaimableOperationKeyDeriver,
	type ClaimableResolverScope,
	claimableOperationKey,
	claimablePublicResourceId,
	claimableResourceRef,
	type ResolveRequest,
} from "@hobo/core";
import { depositSecret, type SecretCustodyPort } from "./custody.js";
/**
 * Receipts and facts — the serialized outputs that leave this package.
 *
 * These are the artifacts that end up in a plan, an event log, and a support
 * bundle, so they are built by projection from the record rather than by
 * spreading it: a spread quietly republishes whatever a future field holds.
 * {@link assertNoCredentialMaterial} then re-checks the result, because the
 * cost of being wrong here is a credential in an append-only log.
 */

import type {
	NeonClaimSummary as NeonClaimSummaryWire,
	NeonNonSecretEndpoint as NeonNonSecretEndpointWire,
	NeonProviderFact as NeonProviderFactWire,
	NeonProvisionReceipt as NeonProvisionReceiptWire,
	NeonReceiptEndpoints as NeonReceiptEndpointsWire,
} from "./_generated/provider_neon_pb.js";
import type { NeonClaimableDatabase, NeonClaimState } from "./driver.js";
import { NeonProviderError } from "./errors.js";
import { type JsonValue, parseJsonValue } from "./json.js";
import type { DomainView, WireFields } from "./wire.js";

/** Privileged endpoint description retained for native SDK compatibility. */
export type NeonReceiptEndpoint = Readonly<
	WireFields<NeonNonSecretEndpointWire>
>;

// domain-view: both roles are required here — a receipt missing an endpoint is
// not a receipt with an unknown one — where the wire form leaves a submessage
// absent-able.
export type NeonReceiptEndpoints = DomainView<
	NeonReceiptEndpointsWire,
	{
		pooled: NeonReceiptEndpoint;
		direct: NeonReceiptEndpoint;
	}
>;

// domain-view: `state` uses the CUE vocabulary rather than the numeric proto
// enum, and the outstanding-action ids are read-only because a receipt is a
// serialized output, not a working record.
export type NeonReceiptClaimSummary = DomainView<
	NeonClaimSummaryWire,
	{
		state: NeonClaimState;
		boundary: "resource";
		atomicity: "single-resource";
		blockingActionIds: readonly string[];
	}
>;

// domain-view: the locators are optional under exactOptionalPropertyTypes, so
// an absent secret cannot be spelled as the empty string a proto3 scalar
// allows; the endpoints, claim summary, and documented limits are required
// because a receipt without them is not a receipt.
export type NeonProvisionReceipt = DomainView<
	NeonProvisionReceiptWire,
	{
		schemaVersion: "hobo.provider-neon.receipt/v2";
		credentialRef?: string;
		directCredentialRef?: string;
		expiresAtMs: number;
		expirySource: "provider-reported";
		observedAtMs: number;
		claim: NeonReceiptClaimSummary;
		limits: NeonClaimableDatabase["limits"];
		bindingProfiles: readonly string[];
		migrationProfiles: readonly string[];
	}
>;

export type NeonProviderFact = DomainView<
	NeonProviderFactWire,
	{
		kind:
			| "provider.neon.database.provisioned"
			| "provider.neon.database.adopted"
			| "provider.neon.database.observed"
			| "provider.neon.claim.pending-rotation"
			| "provider.neon.claim.completed"
			| "provider.neon.lease.expired";
		occurredAtMs: number;
		detail: Readonly<Record<string, string | number | boolean>>;
	}
>;

export type PublicSerializationOptions = {
	readonly custody: SecretCustodyPort;
	readonly deriveOperationKey: ClaimableOperationKeyDeriver;
	readonly scope: ClaimableResolverScope;
};

export const NEON_BINDING_PROFILE_REFS = [
	"binding.postgresql/v1",
	"binding.neon-serverless/v1",
] as const;

export const NEON_MIGRATION_PROFILE_REFS = [
	"migration.postgres.pg-dump/v1",
	"migration.postgres.logical-copy/v1",
] as const;

/** Shapes that must never appear in a serialized output. */
const FORBIDDEN: readonly {
	readonly name: string;
	readonly pattern: RegExp;
}[] = [
	{
		name: "native-capability-id",
		pattern:
			/"(?:databaseId|database_id|neonProjectId|neon_project_id)"\s*:\s*"[^"]+"/u,
	},
	{ name: "claim-capability-url", pattern: /https:\/\/neon\.new\/claim\//u },
	{ name: "postgres-uri", pattern: /postgres(?:ql)?:\/\//iu },
	{ name: "bearer-token", pattern: /Bearer\s+\S+/iu },
	{
		name: "password-assignment",
		pattern: /\b(?:password|pgpassword|pwd)\s*[=:]\s*[^\s"',}]+/iu,
	},
	{ name: "neon-role-password", pattern: /\bnpg_[A-Za-z0-9_-]{4,}/u },
	{ name: "userinfo-pair", pattern: /\/\/[^/\s:@]+:[^/\s:@]+@/u },
	{ name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
];

export type CredentialScanHit = {
	readonly rule: string;
	readonly excerpt: string;
};

function jsonView(
	value: JsonValue | NeonProvisionReceipt | readonly NeonProviderFact[],
): JsonValue {
	return parseJsonValue(JSON.stringify(value));
}

/** Scan any JSON-serializable value for credential material. */
export function scanForCredentialMaterial(
	value: JsonValue,
): readonly CredentialScanHit[] {
	const serialized = JSON.stringify(value) ?? "";
	const hits: CredentialScanHit[] = [];
	for (const rule of FORBIDDEN) {
		const match = rule.pattern.exec(serialized);
		if (match === null) continue;
		hits.push({
			rule: rule.name,
			excerpt: `[redacted:${rule.name}]`,
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
	throw new NeonProviderError(
		"SECRET_CUSTODY_UNAVAILABLE",
		`${what} contains credential-shaped material (${hits.map((hit) => hit.rule).join(", ")}) and was not emitted`,
	);
}

async function sealIdentity(
	record: NeonClaimableDatabase,
	options: PublicSerializationOptions,
) {
	try {
		if (
			!options?.custody ||
			!options.deriveOperationKey ||
			!options.scope?.tenantId ||
			!options.scope.providerAccountId ||
			!options.scope.scopeId
		)
			throw new Error("private custody and pinned host key required");
		const request: ResolveRequest = {
			ref: {
				slot: "data",
				productId: record.definitionId,
				logicalId: record.resourceRef,
			},
			desired: { idempotencyKey: "public-serialization/v2" },
			credentialRef: "vault://public-serialization/host",
		};
		const operationKey = await claimableOperationKey(
			options.scope,
			request,
			options.deriveOperationKey,
		);
		const resourceRef = await claimableResourceRef(options.scope, request);
		const opaquePhysicalId = await claimablePublicResourceId(
			record.databaseId,
			operationKey,
		);
		const nativeIdentity = await depositSecret(
			options.custody,
			record.databaseId,
			{
				providerId: record.providerId,
				resourceRef,
				purpose: "native-resource-id",
			},
		);
		const claim = await depositSecret(options.custody, record.claim.claimUrl, {
			providerId: record.providerId,
			resourceRef,
			purpose: "claim-url",
		});
		const endpoint = await depositSecret(
			options.custody,
			JSON.stringify(record.endpoints),
			{
				providerId: record.providerId,
				resourceRef: `${resourceRef}/endpoints`,
				purpose: "capability-binding",
			},
		);
		const binding = record.binding
			? await depositSecret(options.custody, JSON.stringify(record.binding), {
					providerId: record.providerId,
					resourceRef: `${resourceRef}/binding`,
					purpose: "capability-binding",
				})
			: undefined;
		const project = await depositSecret(options.custody, record.neonProjectId, {
			providerId: record.providerId,
			resourceRef: `${resourceRef}/project`,
			purpose: "native-resource-id",
		});
		return {
			resourceRef,
			opaquePhysicalId,
			nativeIdentityRef: nativeIdentity.ref,
			claimRef: claim.ref,
			endpointRef: endpoint.ref,
			nativeProjectRef: project.ref,
			...(binding ? { bindingRef: binding.ref } : undefined),
		};
	} catch {
		throw new NeonProviderError(
			"SECRET_CUSTODY_UNAVAILABLE",
			"public serialization requires private custody and a pinned host key; publication was refused",
		);
	}
}

function normalizedCapabilityText(value: string): string {
	let decoded = value;
	for (;;) {
		const next = decoded.replace(/%[a-f0-9]{2}/giu, (encoded) =>
			String.fromCharCode(Number.parseInt(encoded.slice(1), 16)),
		);
		if (next === decoded) return decoded.toLowerCase().replaceAll("-", "");
		decoded = next;
	}
}

function assertPublicIdentity(value: JsonValue, record: NeonClaimableDatabase) {
	const serialized = normalizedCapabilityText(JSON.stringify(value));
	for (const hidden of [
		record.databaseId,
		record.neonProjectId,
		record.claim.claimUrl,
	]) {
		if (!hidden || serialized.includes(normalizedCapabilityText(hidden)))
			throw new NeonProviderError(
				"SECRET_CUSTODY_UNAVAILABLE",
				"native capability material was not emitted",
			);
	}
	assertNoCredentialMaterial(value, "public Neon projection");
}

function publicCredentialRef(value: string): string {
	try {
		return parseSecretRef(value).ref;
	} catch {
		throw new NeonProviderError(
			"SECRET_CUSTODY_UNAVAILABLE",
			"public credential locator is invalid; publication was refused",
		);
	}
}

export async function toProvisionReceipt(
	record: NeonClaimableDatabase,
	options: PublicSerializationOptions,
): Promise<NeonProvisionReceipt> {
	const identity = await sealIdentity(record, options);
	const receipt: NeonProvisionReceipt = {
		schemaVersion: "hobo.provider-neon.receipt/v2",
		definitionId: record.definitionId,
		providerId: record.providerId,
		resourceRef: identity.resourceRef,
		opaquePhysicalId: identity.opaquePhysicalId,
		nativeIdentityRef: identity.nativeIdentityRef,
		nativeProjectRef: identity.nativeProjectRef,
		endpointRef: identity.endpointRef,
		...(identity.bindingRef ? { bindingRef: identity.bindingRef } : undefined),
		databaseName: record.databaseName,
		providerStatus: record.providerStatus,
		...(record.directCredentialRef !== undefined
			? { directCredentialRef: publicCredentialRef(record.directCredentialRef) }
			: undefined),
		...(record.credentialRef !== undefined
			? { credentialRef: publicCredentialRef(record.credentialRef) }
			: undefined),
		expiresAtIso: record.expiresAtIso,
		expiresAtMs: record.expiresAtMs,
		expirySource: record.expirySource,
		observedAtMs: record.observedAtMs,
		adopted: record.adopted,
		claim: {
			state: record.claim.state,
			boundary: record.claim.boundary,
			atomicity: record.claim.atomicity,
			claimRef: identity.claimRef,
			blockingActionIds: record.claim.actions
				.filter((action) => action.blocking && !action.completed)
				.map((action) => action.id),
		},
		limits: record.limits,
		bindingProfiles: NEON_BINDING_PROFILE_REFS,
		migrationProfiles: NEON_MIGRATION_PROFILE_REFS,
	};
	assertPublicIdentity(jsonView(receipt), record);
	return receipt;
}

export async function toProviderFacts(
	record: NeonClaimableDatabase,
	options: PublicSerializationOptions,
): Promise<readonly NeonProviderFact[]> {
	const receipt = await toProvisionReceipt(record, options);
	const base = {
		occurredAtMs: record.observedAtMs,
		resourceRef: receipt.resourceRef,
		opaquePhysicalId: receipt.opaquePhysicalId,
		nativeIdentityRef: receipt.nativeIdentityRef,
	};
	const facts: NeonProviderFact[] = [
		{
			...base,
			kind: record.adopted
				? "provider.neon.database.adopted"
				: "provider.neon.database.provisioned",
			detail: {
				expirySource: record.expirySource,
				expiresAtIso: record.expiresAtIso,
				endpointRef: receipt.endpointRef,
				credentialRef: receipt.credentialRef ?? "",
			},
		},
	];
	if (record.claim.state === "claimed-pending-rotation")
		facts.push({
			...base,
			kind: "provider.neon.claim.pending-rotation",
			detail: {
				reason:
					"the pre-claim credential remains live until the owner rotates it",
			},
		});
	if (record.claim.state === "complete")
		facts.push({ ...base, kind: "provider.neon.claim.completed", detail: {} });
	if (record.claim.state === "expired")
		facts.push({
			...base,
			kind: "provider.neon.lease.expired",
			detail: { expiresAtIso: record.expiresAtIso },
		});
	assertPublicIdentity(jsonView(facts), record);
	return facts;
}
