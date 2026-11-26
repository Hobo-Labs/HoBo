/**
 * Typed DigitalOcean offering factories for Yard slot bindings.
 *
 * Why this module exists: authoring a slot binding by hand means typing a
 * capability-profile string, a product id, and an untyped property bag — three
 * independent chances to make a typo that only surfaces at resolution time.
 * Each factory here owns exactly one `(slot, profile, productId)` triple and
 * takes a per-product options interface, so the profile string is never typed
 * by an operator and a misspelled option name is a compile error.
 *
 * Every factory returns `slotBinding()` from `@hobo/core`; none of them build a
 * binding record by hand. The core parse boundary — credential screening,
 * JSON-safety, freezing, key ordering — therefore applies to every binding
 * produced here, and this module adds no parse rules of its own.
 *
 * No defaults are invented. A default droplet size or node count quietly
 * deployed on the caller's behalf would misreport what they asked for, so an
 * omitted option is simply absent from `properties` and the Resource
 * Definition decides.
 *
 * HONEST SCOPE: the `productId` values below are the ids these factories
 * *emit*. Whether a matching Resource Definition is registered in the catalog
 * is checked at resolution time (`YARD_BINDING_PRODUCT_UNKNOWN`), not here — a
 * successful call is not evidence that the product exists in the catalog
 * today, and several of these products are not registered yet.
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
type AnySlotOptions =
	| AppPlatformServiceOptions
	| AppPlatformStaticSiteOptions
	| AppPlatformWorkerOptions
	| AppPlatformJobOptions
	| DropletOptions
	| BlockStorageOptions
	| LoadBalancerOptions
	| ManagedDatabaseOptions
	| SpacesOptions
	| FunctionsOptions
	| KubernetesNodePoolOptions;

function present(options: AnySlotOptions) {
	const out = {};
	for (const [key, value] of Object.entries(options)) {
		if (value !== undefined) Object.assign(out, { [key]: value });
	}
	return out;
}

/** How an App Platform component is reached from outside the app. */
export const APP_PLATFORM_INGRESS = Object.freeze([
	"public",
	"internal",
] as const);

export type AppPlatformIngress = (typeof APP_PLATFORM_INGRESS)[number];

export interface AppPlatformServiceOptions {
	readonly instanceSizeSlug?: string;
	readonly instanceCount?: number;
	readonly ingress?: AppPlatformIngress;
	readonly httpPort?: number;
	readonly image?: string;
}

/** App Platform service — slot `web`, profile `web.hosted/v1`. */
function appPlatformService(options?: AppPlatformServiceOptions): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: capability.web.hosted,
		productId: "digitalocean.app-platform-service/v1",
		properties: present(options ?? {}),
	});
}

export interface AppPlatformStaticSiteOptions {
	readonly outputDir?: string;
	readonly indexDocument?: string;
	readonly errorDocument?: string;
	readonly buildCommand?: string;
}

/**
 * App Platform static site — slot `web`, profile `web.static/v1`. A static
 * site is a narrower profile than `web.hosted/v1`, so it sits beside the hosted
 * options rather than competing with them.
 */
function appPlatformStaticSite(
	options?: AppPlatformStaticSiteOptions,
): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: capability.web.static,
		productId: "digitalocean.app-platform-static-site/v1",
		properties: present(options ?? {}),
	});
}

export interface AppPlatformWorkerOptions {
	readonly instanceSizeSlug?: string;
	readonly instanceCount?: number;
	readonly image?: string;
}

/** App Platform worker — slot `service`, profile `service.worker/v1`. */
function appPlatformWorker(options?: AppPlatformWorkerOptions): SlotBinding {
	return slotBinding({
		slot: "service",
		profile: capability.service.worker,
		productId: "digitalocean.app-platform-worker/v1",
		properties: present(options ?? {}),
	});
}

export interface AppPlatformJobOptions {
	readonly instanceSizeSlug?: string;
	readonly kind?: "pre-deploy" | "post-deploy" | "failed-deploy";
	readonly image?: string;
}

/** App Platform job — slot `service`, profile `service.batch/v1`. */
function appPlatformJob(options?: AppPlatformJobOptions): SlotBinding {
	return slotBinding({
		slot: "service",
		profile: capability.service.batch,
		productId: "digitalocean.app-platform-job/v1",
		properties: present(options ?? {}),
	});
}

/** App Platform namespace, so the call site reads `appPlatform.service({ … })`. */
export const appPlatform = Object.freeze({
	service: appPlatformService,
	staticSite: appPlatformStaticSite,
	worker: appPlatformWorker,
	job: appPlatformJob,
});

export interface DropletOptions {
	readonly size?: string;
	readonly image?: string;
	readonly backups?: boolean;
	readonly monitoring?: boolean;
	readonly ipv6?: boolean;
	readonly vpcUuid?: string;
}

/**
 * A Droplet — slot `web`, profile `web.hosted/v1`. A virtual machine is a
 * genuinely different way to host a web capability from App Platform, so it is
 * its own catalog row and selection picks between them.
 */
export function droplet(options?: DropletOptions): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: capability.web.hosted,
		productId: "digitalocean.droplet/v1",
		properties: present(options ?? {}),
	});
}

/**
 * The same Droplet product reached through the `service` slot as a
 * long-running worker — slot `service`, profile `service.worker/v1`. Rows key
 * on `(profile, productId)`, so both coexist without colliding, and a workload
 * that needs a worker rather than a public origin matches only this one.
 */
export function dropletWorker(options?: DropletOptions): SlotBinding {
	return slotBinding({
		slot: "service",
		profile: capability.service.worker,
		productId: "digitalocean.droplet/v1",
		properties: present(options ?? {}),
	});
}

export interface BlockStorageOptions {
	readonly sizeGigabytes?: number;
	readonly filesystemType?: "ext4" | "xfs";
	readonly snapshotId?: string;
}

/**
 * Block Storage volume — slot `bucket`, profile `bucket.filesystem/v1`. A
 * volume attached to one Droplet has hierarchical path semantics, which is a
 * different profile from Spaces' object API and from a metadata-carrying file
 * share; `bucket.filesystem/v1` refines `bucket.object/v1`, so a workload
 * asking for the general profile still matches.
 */
export function blockStorage(options?: BlockStorageOptions): SlotBinding {
	return slotBinding({
		slot: "bucket",
		profile: capability.bucket.filesystem,
		productId: "digitalocean.block-storage/v1",
		properties: present(options ?? {}),
	});
}

/** Load balancer algorithms this factory can request. */
export const LOAD_BALANCER_ALGORITHMS = Object.freeze([
	"round_robin",
	"least_connections",
] as const);

export type LoadBalancerAlgorithm = (typeof LOAD_BALANCER_ALGORITHMS)[number];

export interface LoadBalancerOptions {
	readonly algorithm?: LoadBalancerAlgorithm;
	readonly sizeUnit?: number;
	readonly redirectHttpToHttps?: boolean;
	readonly vpcUuid?: string;
}

/** DigitalOcean Load Balancer — slot `api`, profile `api.http/v1`. */
export function loadBalancer(options?: LoadBalancerOptions): SlotBinding {
	return slotBinding({
		slot: "api",
		profile: capability.api.http,
		productId: "digitalocean.load-balancer/v1",
		properties: present(options ?? {}),
	});
}

/** Managed database engine sizes are plan slugs, kept as authored strings. */
export interface ManagedDatabaseOptions {
	readonly size?: string;
	readonly nodeCount?: number;
	readonly version?: string;
	readonly storageMib?: number;
	readonly privateNetworkUuid?: string;
}

/** Managed PostgreSQL — slot `data`, profile `data.postgres/v1`. */
function managedPostgres(options?: ManagedDatabaseOptions): SlotBinding {
	return slotBinding({
		slot: "data",
		profile: capability.data.postgres,
		productId: "digitalocean.managed-postgres/v1",
		properties: present(options ?? {}),
	});
}

/** Managed MySQL — slot `data`, profile `data.mysql/v1`. */
function managedMysql(options?: ManagedDatabaseOptions): SlotBinding {
	return slotBinding({
		slot: "data",
		profile: capability.data.mysql,
		productId: "digitalocean.managed-mysql/v1",
		properties: present(options ?? {}),
	});
}

/** Managed MongoDB — slot `data`, profile `data.document/v1`. */
function managedMongodb(options?: ManagedDatabaseOptions): SlotBinding {
	return slotBinding({
		slot: "data",
		profile: capability.data.document,
		productId: "digitalocean.managed-mongodb/v1",
		properties: present(options ?? {}),
	});
}

/** Managed OpenSearch — slot `data`, profile `data.document/v1`. */
function managedOpensearch(options?: ManagedDatabaseOptions): SlotBinding {
	return slotBinding({
		slot: "data",
		profile: capability.data.document,
		productId: "digitalocean.managed-opensearch/v1",
		properties: present(options ?? {}),
	});
}

/** Managed-database namespace, so the call site reads `managed.postgres({ … })`. */
export const managed = Object.freeze({
	postgres: managedPostgres,
	mysql: managedMysql,
	mongodb: managedMongodb,
	opensearch: managedOpensearch,
});

/**
 * Managed Caching (Valkey) — slot `kv`, profile `kv.valkey/v1`.
 *
 * The profile is the *most specific* one that is true, not the most familiar.
 * DigitalOcean renamed this product from Managed Redis and the wire engine slug
 * the API takes is `valkey`, so `kv.valkey/v1` is the honest claim — and since
 * it refines `kv.redis-compatible/v1`, which refines `kv.key-value/v1`, a
 * workload asking for either of those still matches this row. Naming the parent
 * instead would have thrown that precision away for nothing.
 */
export function managedValkey(options?: ManagedDatabaseOptions): SlotBinding {
	return slotBinding({
		slot: "kv",
		profile: capability.kv.valkey,
		productId: "digitalocean.managed-valkey/v1",
		properties: present(options ?? {}),
	});
}

/** Spaces canned ACLs this factory can request. */
export const SPACES_ACLS = Object.freeze(["private", "public-read"] as const);

export type SpacesAcl = (typeof SPACES_ACLS)[number];

export interface SpacesOptions {
	readonly acl?: SpacesAcl;
	readonly cdn?: boolean;
	readonly versioning?: boolean;
}

/**
 * Spaces object storage — slot `bucket`, profile `bucket.s3-compatible/v1`.
 */
export function spaces(options?: SpacesOptions): SlotBinding {
	return slotBinding({
		slot: "bucket",
		profile: capability.bucket.s3Compatible,
		productId: "digitalocean.spaces/v1",
		properties: present(options ?? {}),
	});
}

export interface FunctionsOptions {
	readonly runtime?: string;
	readonly memoryMb?: number;
	readonly timeoutMs?: number;
	readonly web?: boolean;
}

/** DigitalOcean Functions — slot `service`, profile `service.worker/v1`. */
export function functions(options?: FunctionsOptions): SlotBinding {
	return slotBinding({
		slot: "service",
		profile: capability.service.worker,
		productId: "digitalocean.functions/v1",
		properties: present(options ?? {}),
	});
}

export interface KubernetesNodePoolOptions {
	readonly size?: string;
	readonly nodeCount?: number;
	readonly autoScale?: boolean;
	readonly version?: string;
}

/**
 * A DOKS cluster — slot `web`, profile `web.hosted/v1`.
 *
 * The row is the *cluster*, which `/v2/kubernetes/clusters` really does
 * allocate, and hosting a web capability is what a cluster is for. What lands
 * inside it — Deployments, Services, Jobs — belongs to
 * `@hobo/provider-kubernetes`, which resolves those against the cluster's own
 * apiserver; that division is why this factory carries node-pool shape and
 * nothing about workload objects.
 */
export function kubernetesCluster(
	options?: KubernetesNodePoolOptions,
): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: capability.web.hosted,
		productId: "digitalocean.kubernetes-cluster/v1",
		properties: present(options ?? {}),
	});
}
