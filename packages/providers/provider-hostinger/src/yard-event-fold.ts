/**
 * Hostinger event-store fold resolver for Yard placement / generation.
 * Normalizes VPS / DNS / control-plane signals into yard.* facts.
 */

import { isJsonArray, type JsonObject } from "./json.js";

// public-contract: the event-store fold this provider is addressed by. Stored
// events name the resolver that produced them, so a rename orphans every fact
// already written under the old id.
export const HOSTINGER_EVENT_STORE_RESOLVER_ID =
	"hostinger.yard.event-store/v1" as const;

export interface HostingerProviderNativeSignal {
	readonly providerId: "hostinger";
	readonly kind: string;
	readonly payload: JsonObject;
	readonly observedAt?: string;
}

export interface HostingerYardEvent {
	readonly type: string;
	readonly data: JsonObject;
	readonly occurredAt?: string;
}

export function normalizeHostingerYardSignal(
	signal: HostingerProviderNativeSignal,
): readonly HostingerYardEvent[] {
	const at = signal.observedAt ?? new Date().toISOString();
	const p = signal.payload;
	switch (signal.kind) {
		case "dns.zone.created":
			return [
				{
					type: "yard.GenerationProgressed",
					data: {
						attemptId: String(p.attemptId ?? ""),
						idempotencyKey: String(p.idempotencyKey ?? ""),
						providerId: "hostinger",
						status: "started",
						externalRefs: {
							zoneId: String(p.zoneId ?? p.id ?? ""),
							accountRef: String(p.accountRef ?? ""),
						},
					},
					occurredAt: at,
				},
			];
		case "vps.created":
			return [
				{
					type: "yard.GenerationProvisioned",
					data: {
						attemptId: String(p.attemptId ?? ""),
						idempotencyKey: String(p.idempotencyKey ?? ""),
						providerId: "hostinger",
						yardId: String(p.yardId ?? p.virtualMachineId ?? ""),
						externalRefs: {
							virtualMachineId: String(p.virtualMachineId ?? p.id ?? ""),
							zoneId: String(p.zoneId ?? ""),
						},
					},
					occurredAt: at,
				},
			];
		case "vps.running":
			return [
				{
					type: "yard.Registered",
					data: { yard: hostingerYardFromPayload(p) },
					occurredAt: at,
				},
				{
					type: "yard.AttestationStarted",
					data: { yardId: String(p.yardId ?? p.virtualMachineId ?? "") },
					occurredAt: at,
				},
				{
					type: "yard.Attested",
					data: { yardId: String(p.yardId ?? p.virtualMachineId ?? "") },
					occurredAt: at,
				},
				{
					type: "yard.Ready",
					data: {
						yardId: String(p.yardId ?? p.virtualMachineId ?? ""),
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
						providerId: "hostinger",
						failure: {
							code: String(p.code ?? "hostinger-generation-failed"),
							message: String(p.message ?? "Hostinger yard generation failed"),
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
						providerId: "hostinger",
						kind: signal.kind,
						payload: p,
					},
					occurredAt: at,
				},
			];
	}
}

export function hostingerEventStoreFoldDescriptor() {
	return Object.freeze({
		schemaVersion: "hobo.primitive-resolver/v1" as const,
		id: HOSTINGER_EVENT_STORE_RESOLVER_ID,
		version: "1",
		providerId: "hostinger" as const,
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
			"hostinger.control-plane-signal-normalize",
		]),
		implementationRef: "hostinger/resolvers/event-store-fold",
		remediation:
			"Register hostinger.yard.event-store/v1 for Yard event-store folds on Hostinger Yards",
	});
}

function hostingerYardFromPayload(p: JsonObject) {
	const yardId = String(p.yardId ?? p.virtualMachineId ?? "yard:hostinger");
	const now = new Date().toISOString();
	return {
		schemaVersion: "hobo.yard-instance/v1",
		yardId,
		ownerTenantId: String(p.ownerTenantId ?? "local"),
		providerId: "hostinger",
		runtimeId: String(p.runtimeId ?? "hostinger.yard-runtime/v1"),
		layout: {
			providerId: "hostinger",
			regions: isJsonArray(p.regions) ? p.regions.map(String) : ["phx"],
			require: ["managed-container-substrate", "private-network"],
			prefer: [],
			residency: [],
			isolation: [],
			network: ["private"],
			componentHosts: [],
			labels: {},
			properties: {
				...(p.accountRef
					? { "hostinger.accountRef": p.accountRef }
					: undefined),
				...(p.zoneId ? { "hostinger.zoneId": p.zoneId } : undefined),
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
		registryCatalogHash: "sha256:hostinger-registry",
		resolverCatalogHash: "sha256:hostinger-resolvers-v1",
		conformanceHash: "sha256:hostinger-yard-conformance-v1",
		labels: {},
		registrationSeq: 1,
	};
}
