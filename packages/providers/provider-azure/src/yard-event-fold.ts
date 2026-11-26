/**
 * Azure event-store fold resolver for Yard placement / generation.
 * Normalizes Azure control-plane signals (RG, ACA env, etc.) into yard.* facts.
 */

import { isJsonArray, type JsonObject } from "./json.js";

// Lightweight structural types so provider does not hard-depend on broker at runtime
// for descriptor shape (broker imports provider defaults; provider exports pure fold).

// public-contract: the event-store fold this provider is addressed by. Stored
// events name the resolver that produced them, so a rename orphans every fact
// already written under the old id.
export const AZURE_EVENT_STORE_RESOLVER_ID =
	"azure.yard.event-store/v1" as const;

export interface AzureProviderNativeSignal {
	readonly providerId: "azure";
	readonly kind: string;
	readonly payload: JsonObject;
	readonly observedAt?: string;
}

export interface AzureYardEvent {
	readonly type: string;
	readonly data: JsonObject;
	readonly occurredAt?: string;
}

/**
 * Normalize Azure ARM / management signals into yard.* events.
 * Never includes credentials or subscription secrets — refs only.
 */
export function normalizeAzureYardSignal(
	signal: AzureProviderNativeSignal,
): readonly AzureYardEvent[] {
	const at = signal.observedAt ?? new Date().toISOString();
	const p = signal.payload;
	switch (signal.kind) {
		case "resourceGroup.created":
		case "Microsoft.Resources/resourceGroups/write":
			return [
				{
					type: "yard.GenerationProgressed",
					data: {
						attemptId: String(p.attemptId ?? ""),
						idempotencyKey: String(p.idempotencyKey ?? ""),
						providerId: "azure",
						status: "started",
						externalRefs: {
							resourceGroup: String(p.resourceGroup ?? p.name ?? ""),
							subscriptionRef: String(p.subscriptionRef ?? ""),
						},
					},
					occurredAt: at,
				},
			];
		case "managedEnvironment.created":
		case "Microsoft.App/managedEnvironments/write":
			return [
				{
					type: "yard.GenerationProvisioned",
					data: {
						attemptId: String(p.attemptId ?? ""),
						idempotencyKey: String(p.idempotencyKey ?? ""),
						providerId: "azure",
						yardId: String(p.yardId ?? p.environmentId ?? ""),
						externalRefs: {
							managedEnvironmentId: String(
								p.managedEnvironmentId ?? p.id ?? "",
							),
							resourceGroup: String(p.resourceGroup ?? ""),
						},
					},
					occurredAt: at,
				},
			];
		case "managedEnvironment.ready":
			return [
				{
					type: "yard.Registered",
					data: {
						yard: azureYardFromPayload(p),
					},
					occurredAt: at,
				},
				{
					type: "yard.AttestationStarted",
					data: { yardId: String(p.yardId ?? p.id ?? "") },
					occurredAt: at,
				},
				{
					type: "yard.Attested",
					data: { yardId: String(p.yardId ?? p.id ?? "") },
					occurredAt: at,
				},
				{
					type: "yard.Ready",
					data: {
						yardId: String(p.yardId ?? p.id ?? ""),
						attemptId: String(p.attemptId ?? ""),
					},
					occurredAt: at,
				},
			];
		case "generation.failed":
			return [
				{
					type: "yard.GenerationFailed",
					data: {
						attemptId: String(p.attemptId ?? ""),
						idempotencyKey: String(p.idempotencyKey ?? ""),
						providerId: "azure",
						failure: {
							code: String(p.code ?? "azure-generation-failed"),
							message: String(p.message ?? "Azure yard generation failed"),
							retryable: p.retryable === true,
						},
					},
					occurredAt: at,
				},
			];
		default:
			return [
				{
					type: "yard.ProviderSignalNormalized",
					data: {
						providerId: "azure",
						kind: signal.kind,
						payload: p,
					},
					occurredAt: at,
				},
			];
	}
}

export function azureEventStoreFoldDescriptor() {
	return Object.freeze({
		schemaVersion: "hobo.primitive-resolver/v1" as const,
		id: AZURE_EVENT_STORE_RESOLVER_ID,
		version: "1",
		providerId: "azure" as const,
		primitiveKind: "yard" as const,
		slot: "event-store" as const,
		additive: false,
		source: "provider-default" as const,
		default: true,
		priority: 200,
		requiresCapabilities: Object.freeze(["event-store"]),
		providesCapabilities: Object.freeze([
			"event-store",
			"yard-inventory-fold",
			"yard-generation-fold",
			"azure.arm-signal-normalize",
		]),
		implementationRef: "azure/resolvers/event-store-fold",
		remediation:
			"Register azure.yard.event-store/v1 for Yard event-store folds on Azure Yards",
	});
}

function azureYardFromPayload(p: JsonObject) {
	const yardId = String(p.yardId ?? p.id ?? "yard:azure");
	const now = new Date().toISOString();
	return {
		schemaVersion: "hobo.yard-instance/v1",
		yardId,
		ownerTenantId: String(p.ownerTenantId ?? "local"),
		providerId: "azure",
		runtimeId: String(p.runtimeId ?? "azure.yard-runtime/v1"),
		layout: {
			providerId: "azure",
			regions: isJsonArray(p.regions) ? p.regions.map(String) : ["eastus2"],
			require: ["managed-container-substrate", "private-network"],
			prefer: [],
			residency: [],
			isolation: [],
			network: ["private"],
			componentHosts: [],
			labels: {},
			properties: {
				...(p.subscriptionRef
					? { "azure.subscriptionRef": p.subscriptionRef }
					: undefined),
				...(p.tenantRef ? { "azure.tenantRef": p.tenantRef } : undefined),
				...(p.resourceGroup
					? { "azure.resourceGroup": p.resourceGroup }
					: undefined),
			},
			camps: [],
		},
		capabilities: [
			"managed-container-substrate",
			"private-network",
			"managed-http-runtime",
		],
		status: "registering",
		health: { observedAt: now, generation: 1, signals: ["registered"] },
		capacity: { classes: { default: 100 }, reservations: {} },
		registryCatalogHash: "sha256:azure-registry",
		resolverCatalogHash: "sha256:azure-resolvers-v1",
		conformanceHash: "sha256:azure-yard-conformance-v1",
		labels: {},
		registrationSeq: 1,
	};
}
