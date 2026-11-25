import { type GcpYardSpecOptions, gcpYardSpec } from "@hobo/provider-gcp";
import type { Yard as ParsedYard } from "@hobo/yards";

import {
	type ComposedYardOptions,
	composeYard,
	regionOption,
} from "./compose.js";

export {
	type ApiGatewayOptions,
	type AppEngineOptions,
	apiGateway,
	appEngine,
	CLOUD_FUNCTIONS_GENERATIONS,
	CLOUD_RUN_INGRESS,
	CLOUD_STORAGE_CLASSES,
	type CloudFunctionsGeneration,
	type CloudFunctionsOptions,
	type CloudRunIngress,
	type CloudRunJobOptions,
	type CloudRunOptions,
	type CloudSqlMysqlOptions,
	type CloudSqlPostgresOptions,
	type CloudStorageClass,
	type CloudStorageOptions,
	type CloudStorageSiteOptions,
	type CloudTasksOptions,
	type ComputeEngineInstanceOptions,
	cloudFunctions,
	cloudRun,
	cloudRunJob,
	cloudSqlMysql,
	cloudSqlPostgres,
	cloudStorage,
	cloudStorageSite,
	cloudTasks,
	computeEngineInstance,
	FIRESTORE_MODES,
	type FirestoreMode,
	type FirestoreOptions,
	firestore,
	MEMORYSTORE_TIERS,
	type MemorystoreRedisOptions,
	type MemorystoreTier,
	memorystoreRedis,
	type PersistentDiskOptions,
	type PubsubOptions,
	persistentDisk,
	pubsub,
	SECRET_MANAGER_REPLICATION,
	type SecretManagerOptions,
	type SecretManagerReplication,
	secretManager,
} from "@hobo/provider-gcp";

// public-contract: the provider id the authoring surface reads off this namespace; changing it repoints every Yard opened with yard(gcp, …).
export const PROVIDER_ID = "gcp";

// public-contract: the name every default GCP Yard is registered under; changing it renames them all.
export const DEFAULT_GCP_YARD_NAME = "gcp";

export interface GcpYardOptions
	extends ComposedYardOptions,
		GcpYardSpecOptions {}

export function Yard(options: GcpYardOptions = {}): ParsedYard {
	return composeYard(
		DEFAULT_GCP_YARD_NAME,
		gcpYardSpec(regionOption(options.regions)),
		options,
	);
}
