/**
 * Kubernetes provider-owned Yard runtime + primitive resolver defaults.
 * Generation requires Broker policy approval (default deny).
 */

// public-contract: the Yard runtime this provider registers under. Stations and
// the Broker match registrations by this exact string, so changing it silently
// unregisters every Yard already placed on it.
export const KUBERNETES_YARD_RUNTIME_ID = "kubernetes.yard-runtime/v1" as const;
// public-contract: the connector id Broker policy is written against. Generation
// is default-deny, so a rename does not fail open — it stops matching the
// approval that let this provider generate Yards at all.
export const KUBERNETES_YARD_GENERATOR_CONNECTOR_ID =
	"connector:kubernetes-yard-generator" as const;

export function kubernetesYardRuntimeRegistration(options?: {
	readonly status?: "registered" | "approved" | "disabled";
	readonly priority?: number;
}): {
	readonly schemaVersion: "hobo.yard-runtime/v1";
	readonly runtimeId: typeof KUBERNETES_YARD_RUNTIME_ID;
	readonly providerId: "kubernetes";
	readonly version: string;
	readonly supportedKind: {
		readonly regions: readonly string[];
		readonly capabilities: readonly string[];
		readonly requireProperties: readonly string[];
	};
	readonly resolverCatalogHash: `sha256:${string}`;
	readonly generatorConnectorId: typeof KUBERNETES_YARD_GENERATOR_CONNECTOR_ID;
	readonly generatorKind: "kubernetes";
	readonly default: boolean;
	readonly priority: number;
	readonly requiredPermissions: readonly string[];
	readonly conformanceRef: string;
	readonly conformanceHash: `sha256:${string}`;
	readonly status: "registered" | "approved" | "disabled";
} {
	return Object.freeze({
		schemaVersion: "hobo.yard-runtime/v1",
		runtimeId: KUBERNETES_YARD_RUNTIME_ID,
		providerId: "kubernetes",
		version: "1.0.0",
		supportedKind: Object.freeze({
			regions: Object.freeze(["in-cluster"]),
			capabilities: Object.freeze([
				"managed-container-substrate",
				"private-network",
				"scheduled-workload",
			]),
			requireProperties: Object.freeze(["kubernetes.apiServerUrl"]),
		}),
		resolverCatalogHash: "sha256:kubernetes-resolvers-v1",
		generatorConnectorId: KUBERNETES_YARD_GENERATOR_CONNECTOR_ID,
		generatorKind: "kubernetes",
		default: true,
		priority: options?.priority ?? 100,
		requiredPermissions: Object.freeze([
			"namespaces:create",
			"apps/deployments:create",
		]),
		conformanceRef: "hobo://conformance/kubernetes-yard/v1",
		conformanceHash: "sha256:kubernetes-yard-conformance-v1",
		status: options?.status ?? "approved",
	});
}

export function kubernetesDefaultResolverPins(): readonly {
	readonly slot: string;
	readonly resolverId: string;
}[] {
	return Object.freeze([
		Object.freeze({ slot: "scope", resolverId: "kubernetes.yard.scope/v1" }),
		Object.freeze({
			slot: "substrate",
			resolverId: "kubernetes.camp.namespace/v1",
		}),
		Object.freeze({
			slot: "workload",
			resolverId: "kubernetes.bindle.deployment/v1",
		}),
		Object.freeze({
			slot: "network",
			resolverId: "kubernetes.yard.service-network/v1",
		}),
		Object.freeze({
			slot: "event-store",
			resolverId: "kubernetes.yard.event-store/v1",
		}),
	]);
}
