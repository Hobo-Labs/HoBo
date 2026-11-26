/**
 * DigitalOcean provider-owned Yard runtime + primitive resolver defaults.
 * Generation requires Broker policy approval (default deny).
 */

// public-contract: the Yard runtime this provider registers under. Stations and
// the Broker match registrations by this exact string, so changing it silently
// unregisters every Yard already placed on it.
export const DIGITALOCEAN_YARD_RUNTIME_ID =
	"digitalocean.yard-runtime/v1" as const;
// public-contract: the connector id Broker policy is written against. Generation
// is default-deny, so a rename does not fail open — it stops matching the
// approval that let this provider generate Yards at all.
export const DIGITALOCEAN_YARD_GENERATOR_CONNECTOR_ID =
	"connector:digitalocean-yard-generator" as const;

export function digitaloceanYardRuntimeRegistration(options?: {
	readonly status?: "registered" | "approved" | "disabled";
	readonly priority?: number;
}): {
	readonly schemaVersion: "hobo.yard-runtime/v1";
	readonly runtimeId: typeof DIGITALOCEAN_YARD_RUNTIME_ID;
	readonly providerId: "digitalocean";
	readonly version: string;
	readonly supportedCatalog: {
		readonly regions: readonly string[];
		readonly capabilities: readonly string[];
		readonly requireProperties: readonly string[];
	};
	readonly resolverCatalogHash: `sha256:${string}`;
	readonly generatorConnectorId: typeof DIGITALOCEAN_YARD_GENERATOR_CONNECTOR_ID;
	readonly generatorKind: "digitalocean";
	readonly default: boolean;
	readonly priority: number;
	readonly requiredPermissions: readonly string[];
	readonly conformanceRef: string;
	readonly conformanceHash: `sha256:${string}`;
	readonly status: "registered" | "approved" | "disabled";
} {
	return Object.freeze({
		schemaVersion: "hobo.yard-runtime/v1",
		runtimeId: DIGITALOCEAN_YARD_RUNTIME_ID,
		providerId: "digitalocean",
		version: "1.0.0",
		supportedCatalog: Object.freeze({
			regions: Object.freeze(["nyc3", "sfo3", "ams3", "fra1"]),
			capabilities: Object.freeze([
				"managed-container-substrate",
				"private-network",
				"managed-http-runtime",
			]),
			requireProperties: Object.freeze(["digitalocean.teamRef"]),
		}),
		resolverCatalogHash: "sha256:digitalocean-resolvers-v1",
		generatorConnectorId: DIGITALOCEAN_YARD_GENERATOR_CONNECTOR_ID,
		generatorKind: "digitalocean",
		default: true,
		priority: options?.priority ?? 100,
		requiredPermissions: Object.freeze(["app:create", "vpc:create"]),
		conformanceRef: "hobo://conformance/digitalocean-yard/v1",
		conformanceHash: "sha256:digitalocean-yard-conformance-v1",
		status: options?.status ?? "approved",
	});
}

export function digitaloceanDefaultResolverPins(): readonly {
	readonly slot: string;
	readonly resolverId: string;
}[] {
	return Object.freeze([
		Object.freeze({ slot: "scope", resolverId: "digitalocean.yard.scope/v1" }),
		Object.freeze({
			slot: "substrate",
			resolverId: "digitalocean.camp.app-platform/v1",
		}),
		Object.freeze({
			slot: "workload",
			resolverId: "digitalocean.bindle.app-service/v1",
		}),
		Object.freeze({ slot: "network", resolverId: "digitalocean.yard.vpc/v1" }),
		Object.freeze({
			slot: "event-store",
			resolverId: "digitalocean.yard.event-store/v1",
		}),
	]);
}
