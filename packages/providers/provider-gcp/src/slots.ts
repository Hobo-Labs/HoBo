/**
 * Typed Google Cloud offering factories for Yard slot bindings.
 *
 * Why this module exists: authoring a slot binding by hand means typing a
 * capability-profile string, a product id, and an untyped property bag — three
 * independent chances to make a typo that only surfaces at resolution time.
 * Each factory here owns exactly one `(slot, profile, productId)` triple and
 * takes a per-product options interface, so the profile string is never typed
 * by an operator and a misspelled option name is a compile error.
 *
 * A slot is deliberately served by *several* factories where GCP has several
 * products for it: `web` is Cloud Run or App Engine or a Cloud Storage site.
 * These are alternatives a Yard declares as allocatable, not a ranked list and
 * not a mapping — which one an app gets is decided later by selection.
 *
 * Every factory returns `slotBinding()` from `@hobo/core`; none of them build a
 * binding record by hand. The core parse boundary — credential screening,
 * JSON-safety, freezing, key ordering — therefore applies to every binding
 * produced here, and this module adds no parse rules of its own.
 *
 * No defaults are invented. A machine tier or instance count silently chosen on
 * the caller's behalf would misreport what they asked for, so an omitted option
 * is simply absent from `properties` and the Resource Definition decides.
 *
 * HONEST SCOPE: the `productId` values below are the ids these factories
 * *emit*. None of them is registered in the definition catalog today. This
 * package now ships Google REST deployment resolvers, but for only 8 of the 14
 * ids here — see `GCP_RESOLVED_PRODUCT_IDS` / `GCP_UNRESOLVED_PRODUCT_IDS` in
 * `./resolvers.js` for the authoritative split and the per-id reason. Those
 * resolvers are proven against an injected fake transport, never a live
 * project. Whether a matching Resource Definition exists is checked at
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

/** Cloud Run ingress settings this factory can request. */
export const CLOUD_RUN_INGRESS = Object.freeze([
	"all",
	"internal",
	"internal-and-cloud-load-balancing",
] as const);

export type CloudRunIngress = (typeof CLOUD_RUN_INGRESS)[number];

export interface CloudRunOptions {
	readonly minInstances?: number;
	readonly maxInstances?: number;
	readonly cpu?: string;
	readonly memory?: string;
	readonly concurrency?: number;
	readonly ingress?: CloudRunIngress;
	readonly image?: string;
}

/** Cloud Run service — slot `web`, profile `web.hosted/v1`. */
export function cloudRun(options?: CloudRunOptions): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: capability.web.hosted,
		productId: "gcp.cloud-run/v1",
		properties: present(options ?? {}),
	});
}

export interface AppEngineOptions {
	readonly runtimeStack?: string;
	readonly instanceClass?: string;
	readonly minInstances?: number;
	readonly maxInstances?: number;
}

/** App Engine standard service — slot `web`, profile `web.hosted/v1`. */
export function appEngine(options?: AppEngineOptions): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: capability.web.hosted,
		productId: "gcp.app-engine/v1",
		properties: present(options ?? {}),
	});
}

export interface CloudStorageSiteOptions {
	readonly mainPageSuffix?: string;
	readonly notFoundPage?: string;
	readonly cdn?: boolean;
}

/**
 * A static site served from a Cloud Storage bucket — slot `web`, profile
 * `web.static/v1`. Distinct from `cloudStorage()`: the same underlying service,
 * but a website is a different capability from an object store, so it is its
 * own triple rather than an option on the bucket.
 */
export function cloudStorageSite(
	options?: CloudStorageSiteOptions,
): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: capability.web.static,
		productId: "gcp.cloud-storage-site/v1",
		properties: present(options ?? {}),
	});
}

export interface ApiGatewayOptions {
	readonly apiId?: string;
	readonly gatewayId?: string;
	readonly openapiDocument?: string;
}

/** API Gateway — slot `api`, profile `api.http/v1`. */
export function apiGateway(options?: ApiGatewayOptions): SlotBinding {
	return slotBinding({
		slot: "api",
		profile: capability.api.http,
		productId: "gcp.api-gateway/v1",
		properties: present(options ?? {}),
	});
}

/** Cloud Functions generations this factory can request. */
export const CLOUD_FUNCTIONS_GENERATIONS = Object.freeze([
	"gen1",
	"gen2",
] as const);

export type CloudFunctionsGeneration =
	(typeof CLOUD_FUNCTIONS_GENERATIONS)[number];

export interface CloudFunctionsOptions {
	readonly generation?: CloudFunctionsGeneration;
	readonly memoryMb?: number;
	readonly timeoutSeconds?: number;
	readonly runtimeStack?: string;
}

/** Cloud Functions function — slot `service`, profile `service.worker/v1`. */
export function cloudFunctions(options?: CloudFunctionsOptions): SlotBinding {
	return slotBinding({
		slot: "service",
		profile: capability.service.worker,
		productId: "gcp.cloud-functions/v1",
		properties: present(options ?? {}),
	});
}

export interface CloudRunJobOptions {
	readonly tasks?: number;
	readonly parallelism?: number;
	readonly maxRetries?: number;
	readonly taskTimeoutSeconds?: number;
	readonly image?: string;
}

/** Cloud Run job — slot `service`, profile `service.batch/v1`. */
export function cloudRunJob(options?: CloudRunJobOptions): SlotBinding {
	return slotBinding({
		slot: "service",
		profile: capability.service.batch,
		productId: "gcp.cloud-run-job/v1",
		properties: present(options ?? {}),
	});
}

export interface CloudSqlPostgresOptions {
	readonly tier?: string;
	readonly storageGb?: number;
	readonly highAvailability?: boolean;
	readonly engineVersion?: string;
}

/** Cloud SQL for PostgreSQL — slot `data`, profile `data.postgres/v1`. */
export function cloudSqlPostgres(
	options?: CloudSqlPostgresOptions,
): SlotBinding {
	return slotBinding({
		slot: "data",
		profile: capability.data.postgres,
		productId: "gcp.cloud-sql-postgres/v1",
		properties: present(options ?? {}),
	});
}

export interface CloudSqlMysqlOptions {
	readonly tier?: string;
	readonly storageGb?: number;
	readonly highAvailability?: boolean;
	readonly engineVersion?: string;
}

/** Cloud SQL for MySQL — slot `data`, profile `data.mysql/v1`. */
export function cloudSqlMysql(options?: CloudSqlMysqlOptions): SlotBinding {
	return slotBinding({
		slot: "data",
		profile: capability.data.mysql,
		productId: "gcp.cloud-sql-mysql/v1",
		properties: present(options ?? {}),
	});
}

/** Firestore database modes this factory can request. */
export const FIRESTORE_MODES = Object.freeze(["native", "datastore"] as const);

export type FirestoreMode = (typeof FIRESTORE_MODES)[number];

export interface FirestoreOptions {
	readonly mode?: FirestoreMode;
	readonly locationId?: string;
	readonly pointInTimeRecovery?: boolean;
}

/** Firestore database — slot `data`, profile `data.document/v1`. */
export function firestore(options?: FirestoreOptions): SlotBinding {
	return slotBinding({
		slot: "data",
		profile: capability.data.document,
		productId: "gcp.firestore/v1",
		properties: present(options ?? {}),
	});
}

/** Memorystore service tiers this factory can request. */
export const MEMORYSTORE_TIERS = Object.freeze([
	"basic",
	"standard-ha",
] as const);

export type MemorystoreTier = (typeof MEMORYSTORE_TIERS)[number];

export interface MemorystoreRedisOptions {
	readonly tier?: MemorystoreTier;
	readonly memoryGb?: number;
	readonly engineVersion?: string;
}

/** Memorystore for Redis — slot `kv`, profile `kv.redis-compatible/v1`. */
export function memorystoreRedis(
	options?: MemorystoreRedisOptions,
): SlotBinding {
	return slotBinding({
		slot: "kv",
		profile: capability.kv.redisCompatible,
		productId: "gcp.memorystore-redis/v1",
		properties: present(options ?? {}),
	});
}

/** Cloud Storage classes this factory can request. */
export const CLOUD_STORAGE_CLASSES = Object.freeze([
	"standard",
	"nearline",
	"coldline",
	"archive",
] as const);

export type CloudStorageClass = (typeof CLOUD_STORAGE_CLASSES)[number];

export interface CloudStorageOptions {
	readonly storageClass?: CloudStorageClass;
	readonly versioning?: boolean;
	readonly uniformBucketLevelAccess?: boolean;
	readonly publicAccessBlocked?: boolean;
}

/** Cloud Storage bucket — slot `bucket`, profile `bucket.object/v1`. */
export function cloudStorage(options?: CloudStorageOptions): SlotBinding {
	return slotBinding({
		slot: "bucket",
		profile: capability.bucket.object,
		productId: "gcp.cloud-storage/v1",
		properties: present(options ?? {}),
	});
}

export interface CloudTasksOptions {
	readonly maxDispatchesPerSecond?: number;
	readonly maxConcurrentDispatches?: number;
	readonly maxAttempts?: number;
}

/** Cloud Tasks queue — slot `queue`, profile `queue.at-least-once/v1`. */
export function cloudTasks(options?: CloudTasksOptions): SlotBinding {
	return slotBinding({
		slot: "queue",
		profile: capability.queue.atLeastOnce,
		productId: "gcp.cloud-tasks/v1",
		properties: present(options ?? {}),
	});
}

export interface PubsubOptions {
	readonly messageRetentionSeconds?: number;
	readonly messageOrdering?: boolean;
	readonly schemaId?: string;
}

/** Pub/Sub topic — slot `topic`, profile `topic.pubsub/v1`. */
export function pubsub(options?: PubsubOptions): SlotBinding {
	return slotBinding({
		slot: "topic",
		profile: capability.topic.pubsub,
		productId: "gcp.pubsub-topic/v1",
		properties: present(options ?? {}),
	});
}

/** Secret Manager replication policies this factory can request. */
export const SECRET_MANAGER_REPLICATION = Object.freeze([
	"automatic",
	"user-managed",
] as const);

export type SecretManagerReplication =
	(typeof SECRET_MANAGER_REPLICATION)[number];

export interface SecretManagerOptions {
	readonly replication?: SecretManagerReplication;
	readonly replicaLocations?: readonly string[];
	readonly rotationPeriodSeconds?: number;
}

/**
 * Secret Manager — slot `secretRef`, profile `secret-ref.locator/v1`. The
 * options describe where a locator resolves, never the value it resolves to: a
 * credential-shaped property is refused by the core parse boundary.
 */
export function secretManager(options?: SecretManagerOptions): SlotBinding {
	return slotBinding({
		slot: "secretRef",
		profile: capability.secretRef.locator,
		productId: "gcp.secret-manager/v1",
		properties: present(options ?? {}),
	});
}

type AnySlotOptions =
	| ComputeEngineInstanceOptions
	| PersistentDiskOptions
	| CloudRunOptions
	| AppEngineOptions
	| CloudStorageSiteOptions
	| ApiGatewayOptions
	| CloudFunctionsOptions
	| CloudRunJobOptions
	| CloudSqlPostgresOptions
	| CloudSqlMysqlOptions
	| FirestoreOptions
	| MemorystoreRedisOptions
	| CloudStorageOptions
	| CloudTasksOptions
	| PubsubOptions
	| SecretManagerOptions;

export interface ComputeEngineInstanceOptions {
	/** A machine type such as `e2-small`. Types ending in `-metal` are bare metal, not VMs. */
	readonly machineType?: string;
	readonly image?: string;
	readonly zone?: string;
	readonly network?: string;
}

/**
 * Compute Engine VM instance — slot `service`, profile `service.worker/v1`: a long-running
 * virtual machine. Catalog only: this package ships no resolver for it. It is
 * deliberately not also listed under `web.hosted/v1`; a VM can host a web
 * origin, but that row is left for the change that models its public address.
 */
export function computeEngineInstance(
	options?: ComputeEngineInstanceOptions,
): SlotBinding {
	return slotBinding({
		slot: "service",
		profile: capability.service.worker,
		productId: "gcp.compute-engine-instance/v1",
		properties: present(options ?? {}),
	});
}

export interface PersistentDiskOptions {
	readonly sizeGb?: number;
	/** A disk type such as `pd-balanced`. */
	readonly diskType?: string;
}

/**
 * Compute Engine Persistent Disk — slot `bucket`, profile `bucket.filesystem/v1`. A block
 * device formatted and attached to one virtual machine has hierarchical path
 * semantics, which is `bucket.filesystem/v1`. Catalog only: this package ships
 * no resolver for it.
 */
export function persistentDisk(options?: PersistentDiskOptions): SlotBinding {
	return slotBinding({
		slot: "bucket",
		profile: capability.bucket.filesystem,
		productId: "gcp.persistent-disk/v1",
		properties: present(options ?? {}),
	});
}
