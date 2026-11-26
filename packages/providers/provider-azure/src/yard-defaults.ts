/**
 * Azure provider-owned Yard runtime + primitive resolver defaults.
 * Generation requires Broker policy approval (default deny).
 */

// public-contract: the Yard runtime this provider registers under. Stations and
// the Broker match registrations by this exact string, so changing it silently
// unregisters every Yard already placed on it.
export const AZURE_YARD_RUNTIME_ID = "azure.yard-runtime/v1" as const;
// public-contract: the connector id Broker policy is written against. Generation
// is default-deny, so a rename does not fail open — it stops matching the
// approval that let this provider generate Yards at all.
export const AZURE_YARD_GENERATOR_CONNECTOR_ID =
	"connector:azure-yard-generator" as const;

export function azureYardRuntimeRegistration(options?: {
	readonly status?: "registered" | "approved" | "disabled";
	readonly priority?: number;
}): {
	readonly schemaVersion: "hobo.yard-runtime/v1";
	readonly runtimeId: typeof AZURE_YARD_RUNTIME_ID;
	readonly providerId: "azure";
	readonly version: string;
	readonly supportedCatalog: {
		readonly regions: readonly string[];
		readonly capabilities: readonly string[];
		readonly requireProperties: readonly string[];
	};
	readonly resolverCatalogHash: `sha256:${string}`;
	readonly generatorConnectorId: typeof AZURE_YARD_GENERATOR_CONNECTOR_ID;
	readonly generatorKind: "azure";
	readonly default: boolean;
	readonly priority: number;
	readonly requiredPermissions: readonly string[];
	readonly conformanceRef: string;
	readonly conformanceHash: `sha256:${string}`;
	readonly status: "registered" | "approved" | "disabled";
} {
	return Object.freeze({
		schemaVersion: "hobo.yard-runtime/v1",
		runtimeId: AZURE_YARD_RUNTIME_ID,
		providerId: "azure",
		version: "1.0.0",
		supportedCatalog: Object.freeze({
			regions: Object.freeze(["eastus2", "westus2", "westeurope"]),
			capabilities: Object.freeze([
				"managed-container-substrate",
				"private-network",
				"managed-http-runtime",
			]),
			requireProperties: Object.freeze([
				"azure.subscriptionRef",
				"azure.tenantRef",
			]),
		}),
		resolverCatalogHash: "sha256:azure-resolvers-v1",
		generatorConnectorId: AZURE_YARD_GENERATOR_CONNECTOR_ID,
		generatorKind: "azure",
		default: true,
		priority: options?.priority ?? 100,
		requiredPermissions: Object.freeze([
			"Microsoft.Resources/subscriptions/resourceGroups/write",
			"Microsoft.App/managedEnvironments/write",
		]),
		conformanceRef: "hobo://conformance/azure-yard/v1",
		conformanceHash: "sha256:azure-yard-conformance-v1",
		status: options?.status ?? "approved",
	});
}

export function azureDefaultResolverPins(): readonly {
	readonly slot: string;
	readonly resolverId: string;
}[] {
	return Object.freeze([
		Object.freeze({
			slot: "scope",
			resolverId: "azure.yard.scope/v1",
		}),
		Object.freeze({
			slot: "substrate",
			resolverId: "azure.camp.aca-environment/v1",
		}),
		Object.freeze({
			slot: "workload",
			resolverId: "azure.bindle.aca/v1",
		}),
		Object.freeze({
			slot: "network",
			resolverId: "azure.yard.vnet/v1",
		}),
		Object.freeze({
			slot: "event-store",
			resolverId: "azure.yard.event-store/v1",
		}),
	]);
}
