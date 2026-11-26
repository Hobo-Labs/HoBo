/**
 * Hetzner provider-owned Yard runtime + primitive resolver defaults.
 * Generation requires Broker policy approval (default deny).
 */

// public-contract: the Yard runtime this provider registers under. Stations and
// the Broker match registrations by this exact string, so changing it silently
// unregisters every Yard already placed on it.
export const HETZNER_YARD_RUNTIME_ID = "hetzner.yard-runtime/v1" as const;
// public-contract: the connector id Broker policy is written against. Generation
// is default-deny, so a rename does not fail open — it stops matching the
// approval that let this provider generate Yards at all.
export const HETZNER_YARD_GENERATOR_CONNECTOR_ID =
	"connector:hetzner-yard-generator" as const;

export function hetznerYardRuntimeRegistration(options?: {
	readonly status?: "registered" | "approved" | "disabled";
	readonly priority?: number;
}): {
	readonly schemaVersion: "hobo.yard-runtime/v1";
	readonly runtimeId: typeof HETZNER_YARD_RUNTIME_ID;
	readonly providerId: "hetzner";
	readonly version: string;
	readonly supportedCatalog: {
		readonly regions: readonly string[];
		readonly capabilities: readonly string[];
		readonly requireProperties: readonly string[];
	};
	readonly resolverCatalogHash: `sha256:${string}`;
	readonly generatorConnectorId: typeof HETZNER_YARD_GENERATOR_CONNECTOR_ID;
	readonly generatorKind: "hetzner";
	readonly default: boolean;
	readonly priority: number;
	readonly requiredPermissions: readonly string[];
	readonly conformanceRef: string;
	readonly conformanceHash: `sha256:${string}`;
	readonly status: "registered" | "approved" | "disabled";
} {
	return Object.freeze({
		schemaVersion: "hobo.yard-runtime/v1",
		runtimeId: HETZNER_YARD_RUNTIME_ID,
		providerId: "hetzner",
		version: "1.0.0",
		supportedCatalog: Object.freeze({
			regions: Object.freeze(["fsn1", "nbg1", "hel1", "ash"]),
			capabilities: Object.freeze([
				"managed-container-substrate",
				"private-network",
				"managed-http-runtime",
			]),
			requireProperties: Object.freeze(["hetzner.projectRef"]),
		}),
		resolverCatalogHash: "sha256:hetzner-resolvers-v1",
		generatorConnectorId: HETZNER_YARD_GENERATOR_CONNECTOR_ID,
		generatorKind: "hetzner",
		default: true,
		priority: options?.priority ?? 100,
		requiredPermissions: Object.freeze(["server:create", "network:create"]),
		conformanceRef: "hobo://conformance/hetzner-yard/v1",
		conformanceHash: "sha256:hetzner-yard-conformance-v1",
		status: options?.status ?? "approved",
	});
}

export function hetznerDefaultResolverPins(): readonly {
	readonly slot: string;
	readonly resolverId: string;
}[] {
	return Object.freeze([
		Object.freeze({ slot: "scope", resolverId: "hetzner.yard.scope/v1" }),
		Object.freeze({
			slot: "substrate",
			resolverId: "hetzner.camp.server-group/v1",
		}),
		Object.freeze({
			slot: "workload",
			resolverId: "hetzner.bindle.cloud-server/v1",
		}),
		Object.freeze({ slot: "network", resolverId: "hetzner.yard.network/v1" }),
		Object.freeze({
			slot: "event-store",
			resolverId: "hetzner.yard.event-store/v1",
		}),
	]);
}
