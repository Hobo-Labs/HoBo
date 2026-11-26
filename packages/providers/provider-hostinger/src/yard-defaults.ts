/**
 * Hostinger provider-owned Yard runtime + primitive resolver defaults.
 * Generation requires Broker policy approval (default deny).
 */

// public-contract: the Yard runtime this provider registers under. Stations and
// the Broker match registrations by this exact string, so changing it silently
// unregisters every Yard already placed on it.
export const HOSTINGER_YARD_RUNTIME_ID = "hostinger.yard-runtime/v1" as const;
// public-contract: the connector id Broker policy is written against. Generation
// is default-deny, so a rename does not fail open — it stops matching the
// approval that let this provider generate Yards at all.
export const HOSTINGER_YARD_GENERATOR_CONNECTOR_ID =
	"connector:hostinger-yard-generator" as const;

export function hostingerYardRuntimeRegistration(options?: {
	readonly status?: "registered" | "approved" | "disabled";
	readonly priority?: number;
}): {
	readonly schemaVersion: "hobo.yard-runtime/v1";
	readonly runtimeId: typeof HOSTINGER_YARD_RUNTIME_ID;
	readonly providerId: "hostinger";
	readonly version: string;
	readonly supportedCatalog: {
		readonly regions: readonly string[];
		readonly capabilities: readonly string[];
		readonly requireProperties: readonly string[];
	};
	readonly resolverCatalogHash: `sha256:${string}`;
	readonly generatorConnectorId: typeof HOSTINGER_YARD_GENERATOR_CONNECTOR_ID;
	readonly generatorKind: "hostinger";
	readonly default: boolean;
	readonly priority: number;
	readonly requiredPermissions: readonly string[];
	readonly conformanceRef: string;
	readonly conformanceHash: `sha256:${string}`;
	readonly status: "registered" | "approved" | "disabled";
} {
	return Object.freeze({
		schemaVersion: "hobo.yard-runtime/v1",
		runtimeId: HOSTINGER_YARD_RUNTIME_ID,
		providerId: "hostinger",
		version: "1.0.0",
		supportedCatalog: Object.freeze({
			regions: Object.freeze(["phx", "bos", "ams", "sgp"]),
			capabilities: Object.freeze([
				"managed-container-substrate",
				"private-network",
				"managed-http-runtime",
			]),
			requireProperties: Object.freeze(["hostinger.accountRef"]),
		}),
		resolverCatalogHash: "sha256:hostinger-resolvers-v1",
		generatorConnectorId: HOSTINGER_YARD_GENERATOR_CONNECTOR_ID,
		generatorKind: "hostinger",
		default: true,
		priority: options?.priority ?? 100,
		requiredPermissions: Object.freeze(["vps:manage", "dns:manage"]),
		conformanceRef: "hobo://conformance/hostinger-yard/v1",
		conformanceHash: "sha256:hostinger-yard-conformance-v1",
		status: options?.status ?? "approved",
	});
}

export function hostingerDefaultResolverPins(): readonly {
	readonly slot: string;
	readonly resolverId: string;
}[] {
	return Object.freeze([
		Object.freeze({ slot: "scope", resolverId: "hostinger.yard.scope/v1" }),
		Object.freeze({
			slot: "substrate",
			resolverId: "hostinger.camp.vps-group/v1",
		}),
		Object.freeze({
			slot: "workload",
			resolverId: "hostinger.bindle.vps/v1",
		}),
		Object.freeze({ slot: "network", resolverId: "hostinger.yard.dns/v1" }),
		Object.freeze({
			slot: "event-store",
			resolverId: "hostinger.yard.event-store/v1",
		}),
	]);
}
