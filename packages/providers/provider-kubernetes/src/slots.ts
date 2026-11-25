/**
 * Typed Kubernetes offering factories for Yard slot bindings.
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
 * No defaults are invented. A default replica count or storage size quietly
 * deployed on the caller's behalf would misreport what they asked for, so an
 * omitted option is simply absent from `properties` and the Resource
 * Definition decides.
 *
 * HONEST SCOPE — what a cluster is, and is not: every product below is a
 * *built-in* Kubernetes object, reachable from the apiserver of any conformant
 * cluster. There is no database, cache, queue or object store here, because
 * Kubernetes provides none: those arrive through operators, which are
 * third-party software an operator installs, not something the Kubernetes API
 * offers. A `kubernetes.postgres/v1` row would be a claim about software this
 * package cannot see, let alone install, so the `data`, `kv`, `queue` and
 * `topic` slots stay empty.
 */

import { capability, type SlotBinding, slotBinding } from "@hobo/core";
import { isJsonObject, type JsonBag, type JsonObject } from "./json.js";

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
function present<T extends object>(options: T): JsonObject {
	const out: JsonBag = {};
	for (const [key, value] of Object.entries(options)) {
		if (value === undefined) {
			continue;
		}
		out[key] =
			isJsonObject(value) && value !== null && !Array.isArray(value)
				? present(value)
				: value;
	}
	return out;
}

/** Container compute quantities, kept as authored strings (`"500m"`, `"1Gi"`). */
export interface ResourceQuantities {
	readonly cpu?: string;
	readonly memory?: string;
}

export interface DeploymentOptions {
	readonly replicas?: number;
	readonly image?: string;
	readonly limits?: ResourceQuantities;
	readonly requests?: ResourceQuantities;
	readonly namespace?: string;
}

/** A Deployment fronting a web capability — slot `web`, `web.hosted/v1`. */
export function deployment(options?: DeploymentOptions): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: capability.web.hosted,
		productId: "kubernetes.deployment/v1",
		properties: present(options ?? {}),
	});
}

/**
 * The same Deployment product reached through the `service` slot as a
 * long-running worker — slot `service`, profile `service.worker/v1`. Rows key
 * on `(profile, productId)`, so both coexist without colliding, and a workload
 * that needs a worker rather than a public origin matches only this one.
 */
export function deploymentWorker(options?: DeploymentOptions): SlotBinding {
	return slotBinding({
		slot: "service",
		profile: capability.service.worker,
		productId: "kubernetes.deployment/v1",
		properties: present(options ?? {}),
	});
}

export interface StatefulSetOptions extends DeploymentOptions {
	readonly serviceName?: string;
	readonly volumeClaimStorage?: string;
}

/**
 * A StatefulSet fronting a web capability — slot `web`, `web.hosted/v1`. It is
 * a distinct controller from a Deployment, not a variant of one: stable network
 * identity and per-replica storage are what a workload picks it *for*, so it is
 * its own catalog row and selection chooses between them.
 */
export function statefulSet(options?: StatefulSetOptions): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: capability.web.hosted,
		productId: "kubernetes.statefulset/v1",
		properties: present(options ?? {}),
	});
}

/** The same StatefulSet reached as a worker — `service.worker/v1`. */
export function statefulSetWorker(options?: StatefulSetOptions): SlotBinding {
	return slotBinding({
		slot: "service",
		profile: capability.service.worker,
		productId: "kubernetes.statefulset/v1",
		properties: present(options ?? {}),
	});
}

export interface DaemonSetOptions extends DeploymentOptions {
	readonly nodeSelector?: Readonly<Record<string, string>>;
}

/**
 * A DaemonSet — slot `service`, profile `service.worker/v1`. One pod per node
 * is a real placement guarantee a log shipper or node agent needs, and no other
 * controller here provides it.
 */
export function daemonSet(options?: DaemonSetOptions): SlotBinding {
	return slotBinding({
		slot: "service",
		profile: capability.service.worker,
		productId: "kubernetes.daemonset/v1",
		properties: present(options ?? {}),
	});
}

/** Service types a workload can be fronted with. */
export const SERVICE_TYPES = Object.freeze([
	"ClusterIP",
	"NodePort",
	"LoadBalancer",
] as const);

export type ServiceType = (typeof SERVICE_TYPES)[number];

export interface ServiceOptions {
	readonly type?: ServiceType;
	readonly port?: number;
	readonly targetPort?: number;
	readonly namespace?: string;
}

/** A Service — slot `api`, profile `api.http/v1`. */
export function service(options?: ServiceOptions): SlotBinding {
	return slotBinding({
		slot: "api",
		profile: capability.api.http,
		productId: "kubernetes.service/v1",
		properties: present(options ?? {}),
	});
}

export interface IngressOptions {
	readonly className?: string;
	readonly host?: string;
	readonly path?: string;
	readonly tlsSecretRef?: string;
	readonly namespace?: string;
}

/**
 * An Ingress — slot `api`, profile `api.http/v1`. The object is only half the
 * capability: without a controller installed in the cluster an Ingress routes
 * nothing, which is why it sits beside `service()` rather than replacing it.
 */
export function ingress(options?: IngressOptions): SlotBinding {
	return slotBinding({
		slot: "api",
		profile: capability.api.http,
		productId: "kubernetes.ingress/v1",
		properties: present(options ?? {}),
	});
}

export interface JobOptions {
	readonly image?: string;
	readonly backoffLimit?: number;
	readonly completions?: number;
	readonly parallelism?: number;
	readonly namespace?: string;
}

/** A Job — slot `service`, profile `service.batch/v1`. */
export function job(options?: JobOptions): SlotBinding {
	return slotBinding({
		slot: "service",
		profile: capability.service.batch,
		productId: "kubernetes.job/v1",
		properties: present(options ?? {}),
	});
}

export interface CronJobOptions {
	readonly schedule?: string;
	readonly image?: string;
	readonly concurrencyPolicy?: "Allow" | "Forbid" | "Replace";
	readonly namespace?: string;
}

/** A CronJob — slot `service`, profile `service.scheduled/v1`. */
export function cronJob(options?: CronJobOptions): SlotBinding {
	return slotBinding({
		slot: "service",
		profile: capability.service.scheduled,
		productId: "kubernetes.cronjob/v1",
		properties: present(options ?? {}),
	});
}

export interface PersistentVolumeClaimOptions {
	readonly storage?: string;
	readonly storageClassName?: string;
	readonly accessMode?: "ReadWriteOnce" | "ReadOnlyMany" | "ReadWriteMany";
	readonly namespace?: string;
}

/**
 * A PersistentVolumeClaim — slot `bucket`, profile `bucket.filesystem/v1`.
 *
 * A PVC is mounted into a pod at a path, so `bucket.filesystem/v1` is the most
 * specific true profile; it refines `bucket.object/v1`, so a workload asking
 * for the general profile still matches, while one that needs S3 semantics
 * correctly does not.
 */
export function persistentVolumeClaim(
	options?: PersistentVolumeClaimOptions,
): SlotBinding {
	return slotBinding({
		slot: "bucket",
		profile: capability.bucket.filesystem,
		productId: "kubernetes.persistent-volume-claim/v1",
		properties: present(options ?? {}),
	});
}

export interface SecretOptions {
	readonly type?: string;
	readonly namespace?: string;
	/** The key inside the Secret a binding should read. Never the value. */
	readonly key?: string;
}

/**
 * A Secret — slot `secretRef`, profile `secret-ref.runtime-projection/v1`.
 *
 * The projection is the point: Kubernetes mounts a Secret into the pod's
 * filesystem or environment at admission, so the workload reads material it
 * never fetched and HoBo never handled. That is a stronger claim than
 * `secret-ref.locator/v1`, which it refines — so a workload asking only for a
 * locator still matches, and one that needs the material to arrive without a
 * fetch matches only rows like this one.
 *
 * The row still never carries material: a credential-shaped option is refused
 * at the core parse boundary, which is also why this product ships no resolver
 * — creating a Secret would mean putting its contents in `desired`, and
 * `desired` is recorded.
 */
export function secret(options?: SecretOptions): SlotBinding {
	return slotBinding({
		slot: "secretRef",
		profile: capability.secretRef.runtimeProjection,
		productId: "kubernetes.secret/v1",
		properties: present(options ?? {}),
	});
}
