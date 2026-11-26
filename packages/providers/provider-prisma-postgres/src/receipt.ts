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
 * Built by projection rather than by spreading the record, then re-scanned.
 * The scanner is the same idea as the Neon one plus `prisma+postgres://`,
 * which is Prisma's own credential-bearing URI scheme.
 */

import type {
	PrismaClaimSummary as PrismaClaimSummaryWire,
	PrismaNonSecretEndpoint as PrismaNonSecretEndpointWire,
	PrismaProviderFact as PrismaProviderFactWire,
	PrismaProvisionReceipt as PrismaProvisionReceiptWire,
} from "./_generated/provider_prisma_postgres_pb.js";
import type { PrismaClaimableDatabase, PrismaClaimState } from "./driver.js";
import { PrismaProviderError } from "./errors.js";
import { type JsonValue, parseJsonValue } from "./json.js";
import type { DomainView, WireFields } from "./wire.js";

export const PRISMA_BINDING_PROFILE_REFS = ["binding.postgresql/v1"] as const;
export const PRISMA_MIGRATION_PROFILE_REFS = [
	"migration.postgres.pg-dump/v1",
] as const;

/** One non-secret address on a receipt, exactly as the wire form declares it. */
export type PrismaReceiptEndpoint = Readonly<
	WireFields<PrismaNonSecretEndpointWire>
>;

// domain-view: `state` uses the CUE vocabulary rather than the numeric proto
// enum, and the outstanding-action ids are read-only because a receipt is a
// serialized output, not a working record.
export type PrismaReceiptClaimSummary = DomainView<
	PrismaClaimSummaryWire,
	{
		state: PrismaClaimState;
		boundary: "resource";
		atomicity: "single-resource";
		blockingActionIds: readonly string[];
	}
>;

// domain-view: the credential locator is optional under
// exactOptionalPropertyTypes, so an absent secret cannot be spelled as the
// empty string a proto3 scalar allows; the endpoint, claim summary, and
// associated-resource reference are required because a receipt without them is
// not a receipt.
export type PrismaProvisionReceipt = DomainView<
	PrismaProvisionReceiptWire,
	{
		schemaVersion: "hobo.provider-prisma-postgres.receipt/v2";
		credentialRef?: string;
		/** Epoch milliseconds as a JSON-safe number; the wire form is int64. */
		expiresAtMs: number;
		expirySource: "cli-local-clock";
		observedAtMs: number;
		outputMode: PrismaClaimableDatabase["outputMode"];
		claim: PrismaReceiptClaimSummary;
		bindingProfiles: readonly string[];
		migrationProfiles: readonly string[];
	}
>;

export type PrismaProviderFact = DomainView<
	PrismaProviderFactWire,
	{
		kind:
			| "provider.prisma.database.provisioned"
			| "provider.prisma.database.adopted"
			| "provider.prisma.claim.pending-rotation"
			| "provider.prisma.claim.completed"
			| "provider.prisma.lease.expired";
		occurredAtMs: number;
		detail: Readonly<Record<string, string | number | boolean>>;
	}
>;

export type PublicSerializationOptions = {
	readonly custody: SecretCustodyPort;
	readonly deriveOperationKey: ClaimableOperationKeyDeriver;
	readonly scope: ClaimableResolverScope;
};

const FORBIDDEN: readonly {
	readonly name: string;
	readonly pattern: RegExp;
}[] = [
	{
		name: "native-capability-id",
		pattern: /"(?:projectId|project_id)"\s*:\s*"[^"]+"/u,
	},
	{
		name: "claim-capability-url",
		pattern: /https:\/\/create-db\.prisma\.io[^\s"<>]*projectID=/u,
	},
	{ name: "postgres-uri", pattern: /postgres(?:ql)?:\/\//iu },
	{ name: "prisma-postgres-uri", pattern: /prisma\+postgres:\/\//iu },
	{ name: "bearer-token", pattern: /Bearer\s+\S+/iu },
	{
		name: "password-assignment",
		pattern: /\b(?:password|pgpassword|pwd)\s*[=:]\s*[^\s"',}]+/iu,
	},
	{ name: "api-key-parameter", pattern: /\bapi_key=[^\s"'&,}]+/iu },
	{ name: "userinfo-pair", pattern: /\/\/[^/\s:@]+:[^/\s:@]+@/u },
	{ name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
];

export type CredentialScanHit = {
	readonly rule: string;
	readonly excerpt: string;
};

function jsonView(
	value: JsonValue | PrismaProvisionReceipt | readonly PrismaProviderFact[],
): JsonValue {
	return parseJsonValue(JSON.stringify(value));
}

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
	throw new PrismaProviderError(
		"SECRET_CUSTODY_UNAVAILABLE",
		`${what} contains credential-shaped material (${hits.map((hit) => hit.rule).join(", ")}) and was not emitted`,
	);
}

async function sealIdentity(
	record: PrismaClaimableDatabase,
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
			record.projectId,
			operationKey,
		);
		const nativeIdentity = await depositSecret(
			options.custody,
			record.projectId,
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
			JSON.stringify(record.endpoint),
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
		const associated = await depositSecret(
			options.custody,
			JSON.stringify(record.claim.associatedResource),
			{
				providerId: record.providerId,
				resourceRef: `${resourceRef}/associated`,
				purpose: "capability-binding",
			},
		);
		return {
			resourceRef,
			opaquePhysicalId,
			nativeIdentityRef: nativeIdentity.ref,
			claimRef: claim.ref,
			endpointRef: endpoint.ref,
			associatedResourceRef: associated.ref,
			...(binding ? { bindingRef: binding.ref } : undefined),
		};
	} catch {
		throw new PrismaProviderError(
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

function assertPublicIdentity(
	value: JsonValue,
	record: PrismaClaimableDatabase,
) {
	const serialized = normalizedCapabilityText(JSON.stringify(value));
	for (const hidden of [record.projectId, record.claim.claimUrl]) {
		if (!hidden || serialized.includes(normalizedCapabilityText(hidden)))
			throw new PrismaProviderError(
				"SECRET_CUSTODY_UNAVAILABLE",
				"native capability material was not emitted",
			);
	}
	assertNoCredentialMaterial(value, "public Prisma projection");
}

function publicCredentialRef(value: string): string {
	try {
		return parseSecretRef(value).ref;
	} catch {
		throw new PrismaProviderError(
			"SECRET_REFERENCE_INVALID",
			"public credential locator is invalid; publication was refused",
		);
	}
}

export async function toProvisionReceipt(
	record: PrismaClaimableDatabase,
	options: PublicSerializationOptions,
): Promise<PrismaProvisionReceipt> {
	const identity = await sealIdentity(record, options);
	const receipt: PrismaProvisionReceipt = {
		schemaVersion: "hobo.provider-prisma-postgres.receipt/v2",
		definitionId: record.definitionId,
		providerId: record.providerId,
		resourceRef: identity.resourceRef,
		opaquePhysicalId: identity.opaquePhysicalId,
		nativeIdentityRef: identity.nativeIdentityRef,
		associatedResourceRef: identity.associatedResourceRef,
		endpointRef: identity.endpointRef,
		...(identity.bindingRef ? { bindingRef: identity.bindingRef } : undefined),
		databaseName: record.databaseName,
		region: record.region,
		documentedTtlHours: record.documentedTtlHours,
		outputMode: record.outputMode,
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
		bindingProfiles: PRISMA_BINDING_PROFILE_REFS,
		migrationProfiles: PRISMA_MIGRATION_PROFILE_REFS,
	};
	assertPublicIdentity(jsonView(receipt), record);
	return receipt;
}

export async function toProviderFacts(
	record: PrismaClaimableDatabase,
	options: PublicSerializationOptions,
): Promise<readonly PrismaProviderFact[]> {
	const receipt = await toProvisionReceipt(record, options);
	const base = {
		occurredAtMs: record.observedAtMs,
		resourceRef: receipt.resourceRef,
		opaquePhysicalId: receipt.opaquePhysicalId,
		nativeIdentityRef: receipt.nativeIdentityRef,
	};
	const facts: PrismaProviderFact[] = [
		{
			...base,
			kind: record.adopted
				? "provider.prisma.database.adopted"
				: "provider.prisma.database.provisioned",
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
			kind: "provider.prisma.claim.pending-rotation",
			detail: {
				reason:
					"the pre-claim credential remains live until the owner rotates it",
			},
		});
	if (record.claim.state === "complete")
		facts.push({
			...base,
			kind: "provider.prisma.claim.completed",
			detail: {},
		});
	if (record.claim.state === "expired")
		facts.push({
			...base,
			kind: "provider.prisma.lease.expired",
			detail: { expiresAtIso: record.expiresAtIso },
		});
	assertPublicIdentity(jsonView(facts), record);
	return facts;
}
