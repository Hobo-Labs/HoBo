/**
 * DigitalOcean event-store fold resolver for Yard placement / generation.
 * Normalizes App Platform / VPC / control-plane signals into yard.* facts.
 */

import { isJsonArray, type JsonObject } from "./json.js";

// public-contract: the event-store fold this provider is addressed by. Stored
// events name the resolver that produced them, so a rename orphans every fact
// already written under the old id.
export const DIGITALOCEAN_EVENT_STORE_RESOLVER_ID =
	"digitalocean.yard.event-store/v1" as const;

export interface DigitalOceanProviderNativeSignal {
	readonly providerId: "digitalocean";
	readonly kind: string;
	readonly payload: JsonObject;
	readonly observedAt?: string;
}

export interface DigitalOceanYardEvent {
	readonly type: string;
	readonly data: JsonObject;
	readonly occurredAt?: string;
}

export function normalizeDigitalOceanYardSignal(
	signal: DigitalOceanProviderNativeSignal,
): readonly DigitalOceanYardEvent[] {
	const at = signal.observedAt ?? new Date().toISOString();
	const p = signal.payload;
	switch (signal.kind) {
		case "vpc.created":
			return [
				{
					type: "yard.GenerationProgressed",
					data: {
						attemptId: String(p.attemptId ?? ""),
						idempotencyKey: String(p.idempotencyKey ?? ""),
						providerId: "digitalocean",
						status: "started",
						externalRefs: {
							vpcUuid: String(p.vpcUuid ?? p.id ?? ""),
							teamRef: String(p.teamRef ?? ""),
						},
					},
					occurredAt: at,
				},
			];
		case "app.created":
			return [
				{
					type: "yard.GenerationProvisioned",
					data: {
						attemptId: String(p.attemptId ?? ""),
						idempotencyKey: String(p.idempotencyKey ?? ""),
						providerId: "digitalocean",
						yardId: String(p.yardId ?? p.appId ?? ""),
						externalRefs: {
							appId: String(p.appId ?? p.id ?? ""),
							vpcUuid: String(p.vpcUuid ?? ""),
						},
					},
					occurredAt: at,
				},
			];
		case "app.active":
			return [
				{
					type: "yard.Registered",
					data: { yard: digitaloceanYardFromPayload(p) },
					occurredAt: at,
				},
				{
					type: "yard.AttestationStarted",
					data: { yardId: String(p.yardId ?? p.appId ?? "") },
					occurredAt: at,
				},
				{
					type: "yard.Attested",
					data: { yardId: String(p.yardId ?? p.appId ?? "") },
					occurredAt: at,
				},
				{
					type: "yard.Ready",
					data: {
						yardId: String(p.yardId ?? p.appId ?? ""),
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
						providerId: "digitalocean",
						failure: {
							code: String(p.code ?? "digitalocean-generation-failed"),
							message: String(
								p.message ?? "DigitalOcean yard generation failed",
							),
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
						providerId: "digitalocean",
						kind: signal.kind,
						payload: p,
					},
					occurredAt: at,
				},
			];
	}
}

export function digitaloceanEventStoreFoldDescriptor() {
	return Object.freeze({
		schemaVersion: "hobo.primitive-resolver/v1" as const,
		id: DIGITALOCEAN_EVENT_STORE_RESOLVER_ID,
		version: "1",
		providerId: "digitalocean" as const,
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
			"digitalocean.control-plane-signal-normalize",
		]),
		implementationRef: "digitalocean/resolvers/event-store-fold",
		remediation:
			"Register digitalocean.yard.event-store/v1 for Yard event-store folds on DigitalOcean Yards",
	});
}

function digitaloceanYardFromPayload(p: JsonObject) {
	const yardId = String(p.yardId ?? p.appId ?? "yard:digitalocean");
	const now = new Date().toISOString();
	return {
		schemaVersion: "hobo.yard-instance/v1",
		yardId,
		ownerTenantId: String(p.ownerTenantId ?? "local"),
		providerId: "digitalocean",
		runtimeId: String(p.runtimeId ?? "digitalocean.yard-runtime/v1"),
		layout: {
			providerId: "digitalocean",
			regions: isJsonArray(p.regions) ? p.regions.map(String) : ["nyc3"],
			require: ["managed-container-substrate", "private-network"],
			prefer: [],
			residency: [],
			isolation: [],
			network: ["private"],
			componentHosts: [],
			labels: {},
			properties: {
				...(p.teamRef ? { "digitalocean.teamRef": p.teamRef } : undefined),
				...(p.vpcUuid ? { "digitalocean.vpcUuid": p.vpcUuid } : undefined),
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
		registryCatalogHash: "sha256:digitalocean-registry",
		resolverCatalogHash: "sha256:digitalocean-resolvers-v1",
		conformanceHash: "sha256:digitalocean-yard-conformance-v1",
		labels: {},
		registrationSeq: 1,
	};
}
