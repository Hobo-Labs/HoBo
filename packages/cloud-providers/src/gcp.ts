/**
 * GCP: the default Yard, plus the slot factories for authoring your own.
 *
 * `Yard()` returns everything GCP *can* allocate — a catalog, not a selection.
 * Which offering a given resource gets is decided later, by ADR-0151 selection,
 * against the requirements the app actually states.
 *
 * HONEST SCOPE: `@hobo/provider-gcp` ships resolvers for part of this
 * catalog (`GCP_RESOLVED_PRODUCT_IDS`; the rest, with reasons, in
 * `GCP_UNRESOLVED_PRODUCT_IDS`), proven only against an injected fake
 * transport. The current count is `providerParity()` in `./parity.js`, derived from
 * those constants rather than restated here, because a restated count drifts.
 * No Resource Definitions are registered for the `gcp.*` product ids, so a
 * deploy against this Yard still fails closed at resolution.
 */
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
	cloudFunctions,
	cloudRun,
	cloudRunJob,
	cloudSqlMysql,
	cloudSqlPostgres,
	cloudStorage,
	cloudStorageSite,
	cloudTasks,
	FIRESTORE_MODES,
	type FirestoreMode,
	type FirestoreOptions,
	firestore,
	MEMORYSTORE_TIERS,
	type MemorystoreRedisOptions,
	type MemorystoreTier,
	memorystoreRedis,
	type PubsubOptions,
	pubsub,
	SECRET_MANAGER_REPLICATION,
	type SecretManagerOptions,
	type SecretManagerReplication,
	secretManager,
} from "@hobo/provider-gcp";

/**
 * This namespace's provider id, read when it is passed to `yard(gcp, …)`.
 *
 * A provider is stated, never inferred: without this the builder would have
 * to guess one from a Yard name or a product-id prefix, which is exactly the
 * load-bearing naming convention ADR-0144 forbids.
 */
// public-contract: the provider id the authoring surface reads off this namespace; changing it repoints every Yard opened with yard(gcp, …).
export const PROVIDER_ID = "gcp";

/** Yard name used when the caller does not supply one. */
// public-contract: the name every default GCP Yard is registered under; changing it renames them all.
export const DEFAULT_GCP_YARD_NAME = "gcp";

export interface GcpYardOptions
	extends ComposedYardOptions,
		GcpYardSpecOptions {}

/** The default GCP Yard: the full allocatable catalog, parsed and canonical. */
export function Yard(options: GcpYardOptions = {}): ParsedYard {
	return composeYard(
		DEFAULT_GCP_YARD_NAME,
		gcpYardSpec(regionOption(options.regions)),
		options,
	);
}
