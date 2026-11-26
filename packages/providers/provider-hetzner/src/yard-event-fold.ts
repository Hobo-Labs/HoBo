/**
 * Hetzner event-store fold resolver for Yard placement / generation.
 * Normalizes Cloud Server / network / control-plane signals into yard.* facts.
 */

import { isJsonArray, type JsonObject } from "./json.js";

// public-contract: the event-store fold this provider is addressed by. Stored
// events name the resolver that produced them, so a rename orphans every fact
// already written under the old id.
export const HETZNER_EVENT_STORE_RESOLVER_ID =
	"hetzner.yard.event-store/v1" as const;

export interface HetznerProviderNativeSignal {
	readonly providerId: "hetzner";
	readonly kind: string;
	readonly payload: JsonObject;
	readonly observedAt?: string;
}

export interface HetznerYardEvent {
	readonly type: string;
	readonly data: JsonObject;
	readonly occurredAt?: string;
}

export function normalizeHetznerYardSignal(
	signal: HetznerProviderNativeSignal,
): readonly HetznerYardEvent[] {
	const at = signal.observedAt ?? new Date().toISOString();
	const p = signal.payload;
	switch (signal.kind) {
		case "network.created":
			return [
				{
					type: "yard.GenerationProgressed",
					data: {
						attemptId: String(p.attemptId ?? ""),
						idempotencyKey: String(p.idempotencyKey ?? ""),
						providerId: "hetzner",
						status: "started",
						externalRefs: {
							networkId: String(p.networkId ?? p.id ?? ""),
							projectRef: String(p.projectRef ?? ""),
						},
					},
					occurredAt: at,
				},
			];
		case "server.created":
			return [
				{
					type: "yard.GenerationProvisioned",
					data: {
						attemptId: String(p.attemptId ?? ""),
						idempotencyKey: String(p.idempotencyKey ?? ""),
						providerId: "hetzner",
						yardId: String(p.yardId ?? p.serverId ?? ""),
						externalRefs: {
							serverId: String(p.serverId ?? p.id ?? ""),
							networkId: String(p.networkId ?? ""),
						},
					},
					occurredAt: at,
				},
			];
		case "server.running":
			return [
				{
					type: "yard.Registered",
					data: { yard: hetznerYardFromPayload(p) },
					occurredAt: at,
				},
				{
					type: "yard.AttestationStarted",
					data: { yardId: String(p.yardId ?? p.serverId ?? "") },
					occurredAt: at,
				},
				{
					type: "yard.Attested",
					data: { yardId: String(p.yardId ?? p.serverId ?? "") },
					occurredAt: at,
				},
				{
					type: "yard.Ready",
					data: {
						yardId: String(p.yardId ?? p.serverId ?? ""),
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
						providerId: "hetzner",
						failure: {
							code: String(p.code ?? "hetzner-generation-failed"),
							message: String(p.message ?? "Hetzner yard generation failed"),
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
						providerId: "hetzner",
						kind: signal.kind,
						payload: p,
					},
					occurredAt: at,
				},
			];
	}
}

export function hetznerEventStoreFoldDescriptor() {
	return Object.freeze({
		schemaVersion: "hobo.primitive-resolver/v1" as const,
		id: HETZNER_EVENT_STORE_RESOLVER_ID,
		version: "1",
		providerId: "hetzner" as const,
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
			"hetzner.control-plane-signal-normalize",
		]),
		implementationRef: "hetzner/resolvers/event-store-fold",
		remediation:
			"Register hetzner.yard.event-store/v1 for Yard event-store folds on Hetzner Yards",
	});
}

function hetznerYardFromPayload(p: JsonObject) {
	const yardId = String(p.yardId ?? p.serverId ?? "yard:hetzner");
	const now = new Date().toISOString();
	return {
		schemaVersion: "hobo.yard-instance/v1",
		yardId,
		ownerTenantId: String(p.ownerTenantId ?? "local"),
		providerId: "hetzner",
		runtimeId: String(p.runtimeId ?? "hetzner.yard-runtime/v1"),
		layout: {
			providerId: "hetzner",
			regions: isJsonArray(p.regions) ? p.regions.map(String) : ["fsn1"],
			require: ["managed-container-substrate", "private-network"],
			prefer: [],
			residency: [],
			isolation: [],
			network: ["private"],
			componentHosts: [],
			labels: {},
			properties: {
				...(p.projectRef ? { "hetzner.projectRef": p.projectRef } : undefined),
				...(p.networkId ? { "hetzner.networkId": p.networkId } : undefined),
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
		registryCatalogHash: "sha256:hetzner-registry",
		resolverCatalogHash: "sha256:hetzner-resolvers-v1",
		conformanceHash: "sha256:hetzner-yard-conformance-v1",
		labels: {},
		registrationSeq: 1,
	};
}
