/**
 * Typed Azure offering factories for Yard slot bindings.
 *
 * Why this module exists: authoring a slot binding by hand means typing a
 * capability-profile string, a product id, and an untyped property bag — three
 * independent chances to make a typo that only surfaces at resolution time.
 * Each factory here owns exactly one `(slot, profile, productId)` triple and
 * takes a per-product options interface, so the profile string is never typed
 * by an operator and a misspelled option name is a compile error.
 *
 * A slot is deliberately served by *several* factories where Azure has several
 * products for it: `web` is Static Web Apps or App Service or Container Apps or
 * AKS. These are alternatives a Yard declares as allocatable, not a ranked list
 * and not a mapping — which one an app gets is decided later by selection.
 *
 * Every factory returns `slotBinding()` from `@hobo/core`; none of them build a
 * binding record by hand. The core parse boundary — credential screening,
 * JSON-safety, freezing, key ordering — therefore applies to every binding
 * produced here, and this module adds no parse rules of its own.
 *
 * No defaults are invented. A sku or replica count silently chosen on the
 * caller's behalf would misreport what they asked for, so an omitted option is
 * simply absent from `properties` and the Resource Definition decides.
 *
 * HONEST SCOPE: the `productId` values below are the ids these factories
 * *emit*. None of them is registered in the definition catalog today. This
 * package now ships ARM deployment resolvers, but for only 7 of the 16 ids
 * here — see `AZURE_RESOLVED_PRODUCT_IDS` / `AZURE_UNRESOLVED_PRODUCT_IDS` in
 * `./resolvers.js` for the authoritative split and the per-id reason. Those
 * resolvers are proven against an injected fake transport, never a live
 * subscription. Whether a matching Resource Definition exists is checked at
 * resolution time (`YARD_BINDING_PRODUCT_UNKNOWN`), not here, so a successful
 * call to a factory below is not evidence that anything can be deployed.
 */
import { capability, type SlotBinding, slotBinding } from "@hobo/core";

/**
 * Forwards the caller's option bag to the parse boundary, dropping only keys
 * whose value is `undefined` (an omitted option must be absent, not an
 * explicit `undefined`, under `exactOptionalPropertyTypes` and JSON-safety).
 *
 * Every remaining key is passed through — including one the option types do
 * not declare — so a key smuggled past the types reaches `slotBinding()` and
 * is screened there. Cherry-picking the known keys instead would silently
 * swallow it, which is exactly the kind of quiet drop this repo refuses.
 */
function present(options: AnySlotOptions) {
	const out = {};
	for (const [key, value] of Object.entries(options)) {
		if (value !== undefined) Object.assign(out, { [key]: value });
	}
	return out;
}

/** Static Web Apps plans this factory can request. */
export const STATIC_WEB_APPS_SKUS = Object.freeze([
	"free",
	"standard",
] as const);

export type StaticWebAppsSku = (typeof STATIC_WEB_APPS_SKUS)[number];

export interface StaticWebAppsOptions {
	readonly sku?: StaticWebAppsSku;
	readonly appLocation?: string;
	readonly outputLocation?: string;
}

/** Azure Static Web Apps — slot `web`, profile `web.static/v1`. */
export function staticWebApps(options?: StaticWebAppsOptions): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: capability.web.static,
		productId: "azure.static-web-apps/v1",
		properties: present(options ?? {}),
	});
}

export interface AppServiceOptions {
	readonly planSku?: string;
	readonly alwaysOn?: boolean;
	readonly instances?: number;
	readonly linuxFxVersion?: string;
}

/** Azure App Service site — slot `web`, profile `web.hosted/v1`. */
export function appService(options?: AppServiceOptions): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: capability.web.hosted,
		productId: "azure.app-service/v1",
		properties: present(options ?? {}),
	});
}

/** Container Apps ingress exposures this factory can request. */
export const CONTAINER_APPS_INGRESS = Object.freeze([
	"external",
	"internal",
	"none",
] as const);

export type ContainerAppsIngress = (typeof CONTAINER_APPS_INGRESS)[number];

export interface ContainerAppsOptions {
	readonly minReplicas?: number;
	readonly maxReplicas?: number;
	readonly cpu?: number;
	readonly memory?: string;
	readonly ingress?: ContainerAppsIngress;
	readonly image?: string;
}

/** Azure Container Apps app — slot `web`, profile `web.hosted/v1`. */
export function containerApps(options?: ContainerAppsOptions): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: capability.web.hosted,
		productId: "azure.container-apps/v1",
		properties: present(options ?? {}),
	});
}

/** Kubernetes service types an AKS workload can front itself with. */
export const AKS_SERVICE_TYPES = Object.freeze([
	"ClusterIP",
	"LoadBalancer",
	"NodePort",
] as const);

export type AksServiceType = (typeof AKS_SERVICE_TYPES)[number];

/** Container compute quantities, kept as authored strings (`"500m"`, `"1Gi"`). */
export interface AksResourceQuantities {
	readonly cpu?: string;
	readonly memory?: string;
}

export interface AksOptions {
	readonly replicas?: number;
	readonly service?: AksServiceType;
	readonly nodePool?: string;
	readonly limits?: AksResourceQuantities;
	readonly requests?: AksResourceQuantities;
	readonly image?: string;
}

/** AKS Deployment + Service — slot `web`, profile `web.hosted/v1`. */
export function aks(options?: AksOptions): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: capability.web.hosted,
		productId: "azure.aks/v1",
		properties: present(options ?? {}),
	});
}

export interface ApiManagementOptions {
	readonly skuName?: string;
	readonly capacity?: number;
	readonly virtualNetworkType?: string;
}

/** Azure API Management — slot `api`, profile `api.http/v1`. */
export function apiManagement(options?: ApiManagementOptions): SlotBinding {
	return slotBinding({
		slot: "api",
		profile: capability.api.http,
		productId: "azure.api-management/v1",
		properties: present(options ?? {}),
	});
}

/** Azure Functions hosting plans this factory can request. */
export const FUNCTIONS_PLANS = Object.freeze([
	"consumption",
	"premium",
	"dedicated",
] as const);

export type FunctionsPlan = (typeof FUNCTIONS_PLANS)[number];

export interface FunctionsOptions {
	readonly plan?: FunctionsPlan;
	readonly runtimeStack?: string;
	readonly timeoutSeconds?: number;
	readonly instanceMemoryMb?: number;
}

/** Azure Functions app — slot `service`, profile `service.worker/v1`. */
export function functions(options?: FunctionsOptions): SlotBinding {
	return slotBinding({
		slot: "service",
		profile: capability.service.worker,
		productId: "azure.functions/v1",
		properties: present(options ?? {}),
	});
}

export interface ContainerAppsServiceOptions {
	readonly minReplicas?: number;
	readonly maxReplicas?: number;
	readonly cpu?: number;
	readonly memory?: string;
	readonly image?: string;
}

/**
 * Azure Container Apps as background compute — slot `service`, profile
 * `service.worker/v1`. Same Azure product as `containerApps()`, deliberately a
 * second factory: a factory owns one `(slot, profile, productId)` triple, and
 * one product serving two slots is two triples, not one overloaded call.
 */
export function containerAppsService(
	options?: ContainerAppsServiceOptions,
): SlotBinding {
	return slotBinding({
		slot: "service",
		profile: capability.service.worker,
		productId: "azure.container-apps/v1",
		properties: present(options ?? {}),
	});
}

export interface PostgresFlexibleOptions {
	readonly skuName?: string;
	readonly storageGb?: number;
	readonly highAvailability?: boolean;
	readonly engineVersion?: string;
}

/**
 * Azure Database for PostgreSQL Flexible Server — slot `data`, profile
 * `data.postgres/v1`.
 */
export function postgresFlexible(
	options?: PostgresFlexibleOptions,
): SlotBinding {
	return slotBinding({
		slot: "data",
		profile: capability.data.postgres,
		productId: "azure.postgres-flexible/v1",
		properties: present(options ?? {}),
	});
}

export interface SqlDatabaseOptions {
	readonly skuName?: string;
	readonly maxSizeGb?: number;
	readonly zoneRedundant?: boolean;
}

/** Azure SQL Database — slot `data`, profile `data.relational/v1`. */
export function sqlDatabase(options?: SqlDatabaseOptions): SlotBinding {
	return slotBinding({
		slot: "data",
		profile: capability.data.relational,
		productId: "azure.sql-database/v1",
		properties: present(options ?? {}),
	});
}

/** Cosmos DB consistency levels this factory can request. */
export const COSMOS_CONSISTENCY_LEVELS = Object.freeze([
	"strong",
	"bounded-staleness",
	"session",
	"consistent-prefix",
	"eventual",
] as const);

export type CosmosConsistencyLevel = (typeof COSMOS_CONSISTENCY_LEVELS)[number];

/** Cosmos DB capacity modes this factory can request. */
export const COSMOS_THROUGHPUT_MODES = Object.freeze([
	"provisioned",
	"serverless",
] as const);

export type CosmosThroughputMode = (typeof COSMOS_THROUGHPUT_MODES)[number];

export interface CosmosDbOptions {
	readonly consistencyLevel?: CosmosConsistencyLevel;
	readonly throughputMode?: CosmosThroughputMode;
	readonly multiRegionWrites?: boolean;
}

/** Azure Cosmos DB (NoSQL API) — slot `data`, profile `data.document/v1`. */
export function cosmosDb(options?: CosmosDbOptions): SlotBinding {
	return slotBinding({
		slot: "data",
		profile: capability.data.document,
		productId: "azure.cosmos-db/v1",
		properties: present(options ?? {}),
	});
}

export interface CosmosTableOptions {
	readonly throughputMode?: CosmosThroughputMode;
	readonly throughputRu?: number;
}

/** Azure Cosmos DB Table API — slot `kv`, profile `kv.key-value/v1`. */
export function cosmosTable(options?: CosmosTableOptions): SlotBinding {
	return slotBinding({
		slot: "kv",
		profile: capability.kv.keyValue,
		productId: "azure.cosmos-table/v1",
		properties: present(options ?? {}),
	});
}

export interface RedisCacheOptions {
	readonly skuName?: string;
	readonly capacity?: number;
	readonly clustered?: boolean;
}

/**
 * Azure Cache for Redis — slot `kv`, profile `kv.redis-compatible/v1`.
 */
export function redisCache(options?: RedisCacheOptions): SlotBinding {
	return slotBinding({
		slot: "kv",
		profile: capability.kv.redisCompatible,
		productId: "azure.cache-for-redis/v1",
		properties: present(options ?? {}),
	});
}

/** Blob access tiers this factory can request. */
export const BLOB_ACCESS_TIERS = Object.freeze([
	"hot",
	"cool",
	"archive",
] as const);

export type BlobAccessTier = (typeof BLOB_ACCESS_TIERS)[number];

/** Storage-account redundancy options this factory can request. */
export const BLOB_REDUNDANCY = Object.freeze([
	"lrs",
	"zrs",
	"grs",
	"ra-grs",
] as const);

export type BlobRedundancy = (typeof BLOB_REDUNDANCY)[number];

export interface BlobStorageOptions {
	readonly accessTier?: BlobAccessTier;
	readonly redundancy?: BlobRedundancy;
	readonly versioning?: boolean;
	readonly publicAccessBlocked?: boolean;
}

/** Azure Blob Storage container — slot `bucket`, profile `bucket.object/v1`. */
export function blobStorage(options?: BlobStorageOptions): SlotBinding {
	return slotBinding({
		slot: "bucket",
		profile: capability.bucket.object,
		productId: "azure.blob-storage/v1",
		properties: present(options ?? {}),
	});
}

export interface StorageQueueOptions {
	readonly visibilityTimeoutSeconds?: number;
	readonly messageTtlSeconds?: number;
}

/**
 * Azure Storage Queue — slot `queue`, profile `queue.at-least-once/v1`.
 */
export function storageQueue(options?: StorageQueueOptions): SlotBinding {
	return slotBinding({
		slot: "queue",
		profile: capability.queue.atLeastOnce,
		productId: "azure.storage-queue/v1",
		properties: present(options ?? {}),
	});
}

export interface ServiceBusQueueOptions {
	readonly sessionsEnabled?: boolean;
	readonly maxDeliveryCount?: number;
	readonly lockDurationSeconds?: number;
	readonly deadLetterOnExpiration?: boolean;
}

/**
 * Azure Service Bus queue — slot `queue`, profile `queue.fifo/v1`. Ordering is
 * a session guarantee on Service Bus, so this is the FIFO profile while
 * `storageQueue()` is the at-least-once one.
 */
export function serviceBusQueue(options?: ServiceBusQueueOptions): SlotBinding {
	return slotBinding({
		slot: "queue",
		profile: capability.queue.fifo,
		productId: "azure.service-bus-queue/v1",
		properties: present(options ?? {}),
	});
}

export interface ServiceBusTopicOptions {
	readonly maxSizeMb?: number;
	readonly duplicateDetection?: boolean;
	readonly partitioned?: boolean;
}

/** Azure Service Bus topic — slot `topic`, profile `topic.pubsub/v1`. */
export function serviceBusTopic(options?: ServiceBusTopicOptions): SlotBinding {
	return slotBinding({
		slot: "topic",
		profile: capability.topic.pubsub,
		productId: "azure.service-bus-topic/v1",
		properties: present(options ?? {}),
	});
}

export interface KeyVaultOptions {
	readonly vaultName?: string;
	readonly rbacAuthorization?: boolean;
	readonly purgeProtection?: boolean;
}

/**
 * Azure Key Vault — slot `secretRef`, profile `secret-ref.locator/v1`. The
 * options name the vault, never a value inside it: a secret value in a binding
 * record is refused by the core parse boundary.
 */
export function keyVault(options?: KeyVaultOptions): SlotBinding {
	return slotBinding({
		slot: "secretRef",
		profile: capability.secretRef.locator,
		productId: "azure.key-vault/v1",
		properties: present(options ?? {}),
	});
}

type AnySlotOptions =
	| VirtualMachineOptions
	| ManagedDiskOptions
	| StaticWebAppsOptions
	| AppServiceOptions
	| ContainerAppsOptions
	| AksResourceQuantities
	| AksOptions
	| ApiManagementOptions
	| FunctionsOptions
	| ContainerAppsServiceOptions
	| PostgresFlexibleOptions
	| SqlDatabaseOptions
	| CosmosDbOptions
	| CosmosTableOptions
	| RedisCacheOptions
	| BlobStorageOptions
	| StorageQueueOptions
	| ServiceBusQueueOptions
	| ServiceBusTopicOptions
	| KeyVaultOptions;

export interface VirtualMachineOptions {
	/** A VM size such as `Standard_B2s`. */
	readonly size?: string;
	readonly image?: string;
	readonly subnet?: string;
}

/**
 * Azure Virtual Machine — slot `service`, profile `service.worker/v1`: a long-running
 * virtual machine. Catalog only: this package ships no resolver for it. It is
 * deliberately not also listed under `web.hosted/v1`; a VM can host a web
 * origin, but that row is left for the change that models its public address.
 */
export function virtualMachine(options?: VirtualMachineOptions): SlotBinding {
	return slotBinding({
		slot: "service",
		profile: capability.service.worker,
		productId: "azure.virtual-machine/v1",
		properties: present(options ?? {}),
	});
}

export interface ManagedDiskOptions {
	readonly sizeGb?: number;
	/** A disk SKU such as `Premium_LRS`. */
	readonly sku?: string;
}

/**
 * Azure managed disk — slot `bucket`, profile `bucket.filesystem/v1`. A block
 * device formatted and attached to one virtual machine has hierarchical path
 * semantics, which is `bucket.filesystem/v1`. Catalog only: this package ships
 * no resolver for it.
 */
export function managedDisk(options?: ManagedDiskOptions): SlotBinding {
	return slotBinding({
		slot: "bucket",
		profile: capability.bucket.filesystem,
		productId: "azure.managed-disk/v1",
		properties: present(options ?? {}),
	});
}
