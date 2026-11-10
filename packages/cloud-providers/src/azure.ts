/**
 * Azure: the default Yard, plus the slot factories for authoring your own.
 *
 * `Yard()` returns everything Azure *can* allocate — a catalog, not a
 * selection. Azure is the clearest case for why a slot holds several entries:
 * `web` legitimately lists Static Web Apps, App Service, Container Apps and AKS
 * side by side, because all four host a web capability. Which one a given app
 * gets is decided later, by ADR-0151 selection.
 *
 * HONEST SCOPE: `@hobo/provider-azure` ships resolvers for part of this
 * catalog (`AZURE_RESOLVED_PRODUCT_IDS`; the rest, with reasons, in
 * `AZURE_UNRESOLVED_PRODUCT_IDS`), proven only against an injected fake
 * transport. The current count is `providerParity()` in `./parity.js`, derived from
 * those constants rather than restated here, because a restated count drifts.
 * No Resource Definitions are registered for the `azure.*` product ids, so a
 * deploy against this Yard still fails closed at resolution.
 */
import { type AzureYardSpecOptions, azureYardSpec } from "@hobo/provider-azure";
import type { Yard as ParsedYard } from "@hobo/yards";

import {
	type ComposedYardOptions,
	composeYard,
	regionOption,
} from "./compose.js";

export {
	AKS_SERVICE_TYPES,
	type AksOptions,
	type AksResourceQuantities,
	type AksServiceType,
	type ApiManagementOptions,
	type AppServiceOptions,
	aks,
	apiManagement,
	appService,
	BLOB_ACCESS_TIERS,
	BLOB_REDUNDANCY,
	type BlobAccessTier,
	type BlobRedundancy,
	type BlobStorageOptions,
	blobStorage,
	CONTAINER_APPS_INGRESS,
	COSMOS_CONSISTENCY_LEVELS,
	COSMOS_THROUGHPUT_MODES,
	type ContainerAppsIngress,
	type ContainerAppsOptions,
	type ContainerAppsServiceOptions,
	type CosmosConsistencyLevel,
	type CosmosDbOptions,
	type CosmosTableOptions,
	type CosmosThroughputMode,
	containerApps,
	containerAppsService,
	cosmosDb,
	cosmosTable,
	FUNCTIONS_PLANS,
	type FunctionsOptions,
	type FunctionsPlan,
	functions,
	type KeyVaultOptions,
	keyVault,
	type PostgresFlexibleOptions,
	postgresFlexible,
	type RedisCacheOptions,
	redisCache,
	type ServiceBusQueueOptions,
	type ServiceBusTopicOptions,
	type SqlDatabaseOptions,
	STATIC_WEB_APPS_SKUS,
	type StaticWebAppsOptions,
	type StaticWebAppsSku,
	type StorageQueueOptions,
	serviceBusQueue,
	serviceBusTopic,
	sqlDatabase,
	staticWebApps,
	storageQueue,
} from "@hobo/provider-azure";

/**
 * This namespace's provider id, read when it is passed to `yard(azure, …)`.
 *
 * A provider is stated, never inferred: without this the builder would have
 * to guess one from a Yard name or a product-id prefix, which is exactly the
 * load-bearing naming convention ADR-0144 forbids.
 */
// public-contract: the provider id the authoring surface reads off this namespace; changing it repoints every Yard opened with yard(azure, …).
export const PROVIDER_ID = "azure";

/** Yard name used when the caller does not supply one. */
// public-contract: the name every default Azure Yard is registered under; changing it renames them all.
export const DEFAULT_AZURE_YARD_NAME = "azure";

export interface AzureYardOptions
	extends ComposedYardOptions,
		AzureYardSpecOptions {}

/** The default Azure Yard: the full allocatable catalog, parsed and canonical. */
export function Yard(options: AzureYardOptions = {}): ParsedYard {
	return composeYard(
		DEFAULT_AZURE_YARD_NAME,
		azureYardSpec(regionOption(options.regions)),
		options,
	);
}
