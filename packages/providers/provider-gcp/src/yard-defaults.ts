/**
 * GCP provider-owned Yard runtime + primitive resolver defaults.
 * Generation requires Broker policy approval (default deny).
 */

// public-contract: the Yard runtime this provider registers under. Stations and
// the Broker match registrations by this exact string, so changing it silently
// unregisters every Yard already placed on it.
export const GCP_YARD_RUNTIME_ID = "gcp.yard-runtime/v1" as const;
// public-contract: the connector id Broker policy is written against. Generation
// is default-deny, so a rename does not fail open — it stops matching the
// approval that let this provider generate Yards at all.
export const GCP_YARD_GENERATOR_CONNECTOR_ID =
	"connector:gcp-yard-generator" as const;

export function gcpYardRuntimeRegistration(options?: {
	readonly status?: "registered" | "approved" | "disabled";
	readonly priority?: number;
}): {
	readonly schemaVersion: "hobo.yard-runtime/v1";
	readonly runtimeId: typeof GCP_YARD_RUNTIME_ID;
	readonly providerId: "gcp";
	readonly version: string;
	readonly supportedCatalog: {
		readonly regions: readonly string[];
		readonly capabilities: readonly string[];
		readonly requireProperties: readonly string[];
	};
	readonly resolverCatalogHash: `sha256:${string}`;
	readonly generatorConnectorId: typeof GCP_YARD_GENERATOR_CONNECTOR_ID;
	readonly generatorKind: "gcp";
	readonly default: boolean;
	readonly priority: number;
	readonly requiredPermissions: readonly string[];
	readonly conformanceRef: string;
	readonly conformanceHash: `sha256:${string}`;
	readonly status: "registered" | "approved" | "disabled";
} {
	return Object.freeze({
		schemaVersion: "hobo.yard-runtime/v1",
		runtimeId: GCP_YARD_RUNTIME_ID,
		providerId: "gcp",
		version: "1.0.0",
		supportedCatalog: Object.freeze({
			regions: Object.freeze(["us-central1", "us-east1", "europe-west1"]),
			capabilities: Object.freeze([
				"managed-container-substrate",
				"private-network",
				"managed-http-runtime",
			]),
			requireProperties: Object.freeze(["gcp.projectRef"]),
		}),
		resolverCatalogHash: "sha256:gcp-resolvers-v1",
		generatorConnectorId: GCP_YARD_GENERATOR_CONNECTOR_ID,
		generatorKind: "gcp",
		default: true,
		priority: options?.priority ?? 100,
		requiredPermissions: Object.freeze([
			"run.services.create",
			"compute.networks.create",
		]),
		conformanceRef: "hobo://conformance/gcp-yard/v1",
		conformanceHash: "sha256:gcp-yard-conformance-v1",
		status: options?.status ?? "approved",
	});
}

export function gcpDefaultResolverPins(): readonly {
	readonly slot: string;
	readonly resolverId: string;
}[] {
	return Object.freeze([
		Object.freeze({ slot: "scope", resolverId: "gcp.yard.scope/v1" }),
		Object.freeze({
			slot: "substrate",
			resolverId: "gcp.camp.cloud-run/v1",
		}),
		Object.freeze({
			slot: "workload",
			resolverId: "gcp.bindle.cloud-run/v1",
		}),
		Object.freeze({ slot: "network", resolverId: "gcp.yard.vpc/v1" }),
		Object.freeze({
			slot: "event-store",
			resolverId: "gcp.yard.event-store/v1",
		}),
	]);
}
