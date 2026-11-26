/**
 * GCP event-store fold resolver for Yard placement / generation.
 * Normalizes Cloud Run / VPC signals into yard.* facts.
 */

import { isJsonArray, type JsonObject } from "./json.js";

// public-contract: the event-store fold this provider is addressed by. Stored
// events name the resolver that produced them, so a rename orphans every fact
// already written under the old id.
export const GCP_EVENT_STORE_RESOLVER_ID = "gcp.yard.event-store/v1" as const;

export interface GcpProviderNativeSignal {
	readonly providerId: "gcp";
	readonly kind: string;
	readonly payload: JsonObject;
	readonly observedAt?: string;
}

export interface GcpYardEvent {
	readonly type: string;
	readonly data: JsonObject;
	readonly occurredAt?: string;
}

export function normalizeGcpYardSignal(
	signal: GcpProviderNativeSignal,
): readonly GcpYardEvent[] {
	const at = signal.observedAt ?? new Date().toISOString();
	const p = signal.payload;
	switch (signal.kind) {
		case "network.created":
		case "compute.networks.create":
			return [
				{
					type: "yard.GenerationProgressed",
					data: {
						attemptId: String(p.attemptId ?? ""),
						idempotencyKey: String(p.idempotencyKey ?? ""),
						providerId: "gcp",
						status: "started",
						externalRefs: {
							network: String(p.network ?? p.name ?? ""),
							projectRef: String(p.projectRef ?? ""),
						},
					},
					occurredAt: at,
				},
			];
		case "cloudRun.service.created":
		case "run.services.create":
			return [
				{
					type: "yard.GenerationProvisioned",
					data: {
						attemptId: String(p.attemptId ?? ""),
						idempotencyKey: String(p.idempotencyKey ?? ""),
						providerId: "gcp",
						yardId: String(p.yardId ?? p.serviceName ?? ""),
						externalRefs: {
							serviceName: String(p.serviceName ?? p.id ?? ""),
							projectRef: String(p.projectRef ?? ""),
						},
					},
					occurredAt: at,
				},
			];
		case "cloudRun.ready":
			return [
				{
					type: "yard.Registered",
					data: { yard: gcpYardFromPayload(p) },
					occurredAt: at,
				},
				{
					type: "yard.AttestationStarted",
					data: { yardId: String(p.yardId ?? p.serviceName ?? "") },
					occurredAt: at,
				},
				{
					type: "yard.Attested",
					data: { yardId: String(p.yardId ?? p.serviceName ?? "") },
					occurredAt: at,
				},
				{
					type: "yard.Ready",
					data: {
						yardId: String(p.yardId ?? p.serviceName ?? ""),
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
						providerId: "gcp",
						failure: {
							code: String(p.code ?? "gcp-generation-failed"),
							message: String(p.message ?? "GCP yard generation failed"),
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
						providerId: "gcp",
						kind: signal.kind,
						payload: p,
					},
					occurredAt: at,
				},
			];
	}
}

export function gcpEventStoreFoldDescriptor() {
	return Object.freeze({
		schemaVersion: "hobo.primitive-resolver/v1" as const,
		id: GCP_EVENT_STORE_RESOLVER_ID,
		version: "1",
		providerId: "gcp" as const,
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
			"gcp.control-plane-signal-normalize",
		]),
		implementationRef: "gcp/resolvers/event-store-fold",
		remediation:
			"Register gcp.yard.event-store/v1 for Yard event-store folds on GCP Yards",
	});
}

function gcpYardFromPayload(p: JsonObject) {
	const yardId = String(p.yardId ?? p.serviceName ?? "yard:gcp");
	const now = new Date().toISOString();
	return {
		schemaVersion: "hobo.yard-instance/v1",
		yardId,
		ownerTenantId: String(p.ownerTenantId ?? "local"),
		providerId: "gcp",
		runtimeId: String(p.runtimeId ?? "gcp.yard-runtime/v1"),
		layout: {
			providerId: "gcp",
			regions: isJsonArray(p.regions) ? p.regions.map(String) : ["us-central1"],
			require: ["managed-container-substrate", "private-network"],
			prefer: [],
			residency: [],
			isolation: [],
			network: ["private"],
			componentHosts: [],
			labels: {},
			properties: {
				...(p.projectRef ? { "gcp.projectRef": p.projectRef } : undefined),
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
		registryCatalogHash: "sha256:gcp-registry",
		resolverCatalogHash: "sha256:gcp-resolvers-v1",
		conformanceHash: "sha256:gcp-yard-conformance-v1",
		labels: {},
		registrationSeq: 1,
	};
}
