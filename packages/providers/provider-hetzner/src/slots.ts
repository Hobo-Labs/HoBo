/**
 * Typed Hetzner offering factories for Yard slot bindings.
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
 * No defaults are invented. A default server type or volume size quietly
 * deployed on the caller's behalf would misreport what they asked for, so an
 * omitted option is simply absent from `properties` and the Resource
 * Definition decides.
 *
 * HONEST SCOPE — what Hetzner is not: there is no managed database, managed
 * cache, managed queue or managed secret store in this list, because Hetzner
 * does not sell one. Running Postgres on a Cloud Server is a thing a person can
 * do; it is not a product this catalog can allocate, and a
 * `hetzner.postgres/v1` row would claim otherwise. The `data`, `kv`, `queue`,
 * `topic` and `secretRef` slots are therefore empty rather than filled with a
 * self-managed near-miss.
 *
 * HONEST SCOPE — catalogue vs registry: the `productId` values below are the
 * ids these factories *emit*. Whether a matching Resource Definition is
 * registered in the catalog is checked at resolution time
 * (`YARD_BINDING_PRODUCT_UNKNOWN`), not here.
 */
import { capability, type SlotBinding, slotBinding } from "@hobo/core";

export const SERVER_ARCHITECTURES = Object.freeze(["x86", "arm"] as const);

export type ServerArchitecture = (typeof SERVER_ARCHITECTURES)[number];

export interface CloudServerOptions {
	readonly serverType?: string;
	readonly image?: string;
	readonly architecture?: ServerArchitecture;
	readonly backups?: boolean;
	readonly placementGroup?: string;
	readonly network?: string;
}

export function cloudServer(options?: CloudServerOptions): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: capability.web.hosted,
		productId: "hetzner.cloud-server/v1",
		properties: present(options ?? {}),
	});
}

export function cloudServerWorker(options?: CloudServerOptions): SlotBinding {
	return slotBinding({
		slot: "service",
		profile: capability.service.worker,
		productId: "hetzner.cloud-server/v1",
		properties: present(options ?? {}),
	});
}

export const LOAD_BALANCER_ALGORITHMS = Object.freeze([
	"round_robin",
	"least_connections",
] as const);

export type LoadBalancerAlgorithm = (typeof LOAD_BALANCER_ALGORITHMS)[number];

export interface LoadBalancerOptions {
	readonly loadBalancerType?: string;
	readonly algorithm?: LoadBalancerAlgorithm;
	readonly network?: string;
	readonly publicInterface?: boolean;
}

export function loadBalancer(options?: LoadBalancerOptions): SlotBinding {
	return slotBinding({
		slot: "api",
		profile: capability.api.http,
		productId: "hetzner.load-balancer/v1",
		properties: present(options ?? {}),
	});
}

export const OBJECT_STORAGE_ACLS = Object.freeze([
	"private",
	"public-read",
] as const);

export type ObjectStorageAcl = (typeof OBJECT_STORAGE_ACLS)[number];

export interface ObjectStorageOptions {
	readonly acl?: ObjectStorageAcl;
	readonly versioning?: boolean;
	readonly objectLock?: boolean;
}

export function objectStorage(options?: ObjectStorageOptions): SlotBinding {
	return slotBinding({
		slot: "bucket",
		profile: capability.bucket.s3Compatible,
		productId: "hetzner.object-storage/v1",
		properties: present(options ?? {}),
	});
}

export interface StorageBoxOptions {
	readonly plan?: string;
	readonly subaccounts?: number;
	readonly snapshots?: boolean;
}

export function storageBox(options?: StorageBoxOptions): SlotBinding {
	return slotBinding({
		slot: "bucket",
		profile: capability.bucket.fileStorage,
		productId: "hetzner.storage-box/v1",
		properties: present(options ?? {}),
	});
}

export interface VolumeOptions {
	readonly sizeGb?: number;
	readonly format?: "ext4" | "xfs";
	readonly automount?: boolean;
}

type AnySlotOptions =
	| CloudServerOptions
	| LoadBalancerOptions
	| ObjectStorageOptions
	| StorageBoxOptions
	| VolumeOptions;

function present(options: AnySlotOptions) {
	const out = {};
	for (const [key, value] of Object.entries(options)) {
		if (value !== undefined) Object.assign(out, { [key]: value });
	}
	return out;
}

export function volume(options?: VolumeOptions): SlotBinding {
	return slotBinding({
		slot: "bucket",
		profile: capability.bucket.filesystem,
		productId: "hetzner.volume/v1",
		properties: present(options ?? {}),
	});
}
