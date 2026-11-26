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

/** Cloud Server CPU families Hetzner offers, as the API's own vocabulary. */
export const SERVER_ARCHITECTURES = Object.freeze(["x86", "arm"] as const);

export type ServerArchitecture = (typeof SERVER_ARCHITECTURES)[number];

export interface CloudServerOptions {
	/** A server-type name such as `cx22` (x86) or `cax11` (arm). */
	readonly serverType?: string;
	readonly image?: string;
	readonly architecture?: ServerArchitecture;
	readonly backups?: boolean;
	readonly placementGroup?: string;
	readonly network?: string;
}

/**
 * Hetzner Cloud Server — slot `web`, profile `web.hosted/v1`. A virtual machine
 * with a public address is how Hetzner hosts a web capability; there is no
 * PaaS lane above it, and this row does not pretend there is.
 */
export function cloudServer(options?: CloudServerOptions): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: capability.web.hosted,
		productId: "hetzner.cloud-server/v1",
		properties: present(options ?? {}),
	});
}

/**
 * The same Cloud Server product reached through the `service` slot as a
 * long-running worker — slot `service`, profile `service.worker/v1`. Rows key
 * on `(profile, productId)`, so both coexist without colliding, and a workload
 * that needs a worker rather than a public origin matches only this one.
 */
export function cloudServerWorker(options?: CloudServerOptions): SlotBinding {
	return slotBinding({
		slot: "service",
		profile: capability.service.worker,
		productId: "hetzner.cloud-server/v1",
		properties: present(options ?? {}),
	});
}

/** Load-balancer algorithms this factory can request. */
export const LOAD_BALANCER_ALGORITHMS = Object.freeze([
	"round_robin",
	"least_connections",
] as const);

export type LoadBalancerAlgorithm = (typeof LOAD_BALANCER_ALGORITHMS)[number];

export interface LoadBalancerOptions {
	/** A load-balancer type name such as `lb11`. */
	readonly loadBalancerType?: string;
	readonly algorithm?: LoadBalancerAlgorithm;
	readonly network?: string;
	readonly publicInterface?: boolean;
}

/** Hetzner Load Balancer — slot `api`, profile `api.http/v1`. */
export function loadBalancer(options?: LoadBalancerOptions): SlotBinding {
	return slotBinding({
		slot: "api",
		profile: capability.api.http,
		productId: "hetzner.load-balancer/v1",
		properties: present(options ?? {}),
	});
}

/** Object Storage canned ACLs this factory can request. */
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

/**
 * Hetzner Object Storage bucket — slot `bucket`, profile
 * `bucket.s3-compatible/v1`.
 */
export function objectStorage(options?: ObjectStorageOptions): SlotBinding {
	return slotBinding({
		slot: "bucket",
		profile: capability.bucket.s3Compatible,
		productId: "hetzner.object-storage/v1",
		properties: present(options ?? {}),
	});
}

export interface StorageBoxOptions {
	/** A Storage Box plan name such as `bx11`. */
	readonly plan?: string;
	readonly subaccounts?: number;
	readonly snapshots?: boolean;
}

/**
 * Hetzner Storage Box — slot `bucket`, profile `bucket.file-storage/v1`. A
 * Storage Box speaks SFTP/SMB and has directory semantics, which is a different
 * capability profile from the S3 surface above, so it is its own row rather
 * than an option on that one.
 */
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

/**
 * Hetzner Volume — slot `bucket`, profile `bucket.filesystem/v1`.
 *
 * A block device formatted ext4 or xfs and attached to one server has
 * hierarchical path semantics, which is `bucket.filesystem/v1` — not
 * `bucket.file-storage/v1`, which is the metadata-carrying user-facing share a
 * Storage Box provides. Both refine `bucket.object/v1`, so a workload asking
 * for the general profile matches either; a workload that actually needs a
 * mounted filesystem now matches only this one.
 */
export function volume(options?: VolumeOptions): SlotBinding {
	return slotBinding({
		slot: "bucket",
		profile: capability.bucket.filesystem,
		productId: "hetzner.volume/v1",
		properties: present(options ?? {}),
	});
}
