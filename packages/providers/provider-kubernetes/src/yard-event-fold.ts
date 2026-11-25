/**
 * Kubernetes event-store fold resolver for Yard placement / generation.
 * Normalizes Namespace / Deployment / apiserver signals into yard.* facts.
 */

import { asJsonObject, type JsonObject, type JsonValue } from "./json.js";

// public-contract: the event-store fold this provider is addressed by. Stored
// events name the resolver that produced them, so a rename orphans every fact
// already written under the old id.
export const KUBERNETES_EVENT_STORE_RESOLVER_ID =
	"kubernetes.yard.event-store/v1" as const;

export interface KubernetesProviderNativeSignal {
	readonly providerId: "kubernetes";
	readonly kind: string;
	readonly payload: Readonly<Record<string, JsonValue>>;
	readonly observedAt?: string;
}

export interface KubernetesYardEvent {
	readonly type: string;
	readonly data: JsonObject;
	readonly occurredAt?: string;
}

export function normalizeKubernetesYardSignal(
	signal: KubernetesProviderNativeSignal,
): readonly KubernetesYardEvent[] {
	const at = signal.observedAt ?? new Date().toISOString();
	const p = signal.payload;
	switch (signal.kind) {
		case "namespace.created":
			return [
				{
					type: "yard.GenerationProgressed",
					data: {
						attemptId: String(p.attemptId ?? ""),
						idempotencyKey: String(p.idempotencyKey ?? ""),
						providerId: "kubernetes",
						status: "started",
						externalRefs: {
							namespace: String(p.namespace ?? p.name ?? ""),
							apiServerUrl: String(p.apiServerUrl ?? ""),
						},
					},
					occurredAt: at,
				},
			];
		case "deployment.created":
			return [
				{
					type: "yard.GenerationProvisioned",
					data: {
						attemptId: String(p.attemptId ?? ""),
						idempotencyKey: String(p.idempotencyKey ?? ""),
						providerId: "kubernetes",
						yardId: String(p.yardId ?? p.uid ?? ""),
						externalRefs: {
							uid: String(p.uid ?? p.id ?? ""),
							namespace: String(p.namespace ?? ""),
						},
					},
					occurredAt: at,
				},
			];
		case "deployment.available":
			return [
				{
					type: "yard.Registered",
					data: { yard: kubernetesYardFromPayload(p) },
					occurredAt: at,
				},
				{
					type: "yard.AttestationStarted",
					data: { yardId: String(p.yardId ?? p.uid ?? "") },
					occurredAt: at,
				},
				{
					type: "yard.Attested",
					data: { yardId: String(p.yardId ?? p.uid ?? "") },
					occurredAt: at,
				},
				{
					type: "yard.Ready",
					data: {
						yardId: String(p.yardId ?? p.uid ?? ""),
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
						providerId: "kubernetes",
						failure: {
							code: String(p.code ?? "kubernetes-generation-failed"),
							message: String(p.message ?? "Kubernetes yard generation failed"),
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
						providerId: "kubernetes",
						kind: signal.kind,
						payload: asJsonObject(p),
					},
					occurredAt: at,
				},
			];
	}
}

export function kubernetesEventStoreFoldDescriptor() {
	return Object.freeze({
		schemaVersion: "hobo.primitive-resolver/v1" as const,
		id: KUBERNETES_EVENT_STORE_RESOLVER_ID,
		version: "1",
		providerId: "kubernetes" as const,
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
			"kubernetes.control-plane-signal-normalize",
		]),
		implementationRef: "kubernetes/resolvers/event-store-fold",
		remediation:
			"Register kubernetes.yard.event-store/v1 for Yard event-store folds on Kubernetes Yards",
	});
}

function kubernetesYardFromPayload(
	p: Readonly<Record<string, JsonValue>>,
): JsonObject {
	const yardId = String(p.yardId ?? p.uid ?? "yard:kubernetes");
	const now = new Date().toISOString();
	return asJsonObject({
		schemaVersion: "hobo.yard-instance/v1",
		yardId,
		ownerTenantId: String(p.ownerTenantId ?? "local"),
		providerId: "kubernetes",
		runtimeId: String(p.runtimeId ?? "kubernetes.yard-runtime/v1"),
		// `layout`, matching YardInstanceRegistration in the broker and every
		// sibling provider's fold. This was emitted as `shape`, which meant a
		// registered Kubernetes yard carried no `layout` for anything reading the
		// canonical record -- the field was simply absent, so placement read it as
		// a yard that declared no regions, requirements or properties at all.
		layout: {
			providerId: "kubernetes",
			regions: Array.isArray(p.regions)
				? p.regions.map(String)
				: ["in-cluster"],
			require: ["managed-container-substrate", "private-network"],
			prefer: [],
			residency: [],
			isolation: [],
			network: ["private"],
			componentHosts: [],
			labels: {},
			properties: {
				...(p.apiServerUrl
					? { "kubernetes.apiServerUrl": p.apiServerUrl }
					: undefined),
				...(p.namespace ? { "kubernetes.namespace": p.namespace } : undefined),
			},
			camps: [],
		},
		capabilities: [
			"managed-container-substrate",
			"private-network",
			"scheduled-workload",
		],
		status: "registering",
		health: { observedAt: now, generation: 1, signals: ["registered"] },
		capacity: { classes: { default: 100 }, reservations: {} },
		registryCatalogHash: "sha256:kubernetes-registry",
		resolverCatalogHash: "sha256:kubernetes-resolvers-v1",
		conformanceHash: "sha256:kubernetes-yard-conformance-v1",
		labels: {},
		registrationSeq: 1,
	});
}
