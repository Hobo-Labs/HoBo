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
	type ManagedDiskOptions,
	managedDisk,
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
	type VirtualMachineOptions,
	virtualMachine,
} from "@hobo/provider-azure";

// public-contract: the provider id the authoring surface reads off this namespace; changing it repoints every Yard opened with yard(azure, …).
export const PROVIDER_ID = "azure";

// public-contract: the name every default Azure Yard is registered under; changing it renames them all.
export const DEFAULT_AZURE_YARD_NAME = "azure";

export interface AzureYardOptions
	extends ComposedYardOptions,
		AzureYardSpecOptions {}

export function Yard(options: AzureYardOptions = {}): ParsedYard {
	return composeYard(
		DEFAULT_AZURE_YARD_NAME,
		azureYardSpec(regionOption(options.regions)),
		options,
	);
}
