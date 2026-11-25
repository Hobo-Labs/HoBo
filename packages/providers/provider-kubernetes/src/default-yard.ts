/**
 * The default Kubernetes Yard catalog: what a cluster *can* allocate, per slot.
 *
 * A Yard declares allocatable capacity. It is not a mapping, not a pool, not a
 * selection, and not a record of what an app uses — so a slot holds a *list*,
 * and several entries in one slot are the normal case, with selection
 * (ADR-0151) picking among them later against the requirements the app
 * actually states. Collapsing a slot to a single value would quietly make this
 * module the selector, which is exactly the decision the Yard is not allowed to
 * take.
 *
 * HONEST SCOPE — how full this catalog is: it is built strictly from the typed
 * factories `./slots.ts` ships, and every one of those is a *built-in*
 * Kubernetes object reachable from any conformant apiserver. Four slots the
 * hyperscaler catalogs carry are absent rather than filled with a near-miss:
 * Kubernetes provides no database, cache, queue or topic, so `data`, `kv`,
 * `queue` and `topic` have no rows. Those capabilities arrive through
 * operators — third-party software an operator installs into the cluster — and
 * a row for one would be a claim about software this package cannot see, let
 * alone install.
 *
 * `kubernetesYardSpec()` emits raw row-shaped data rather than a `Yard`: this
 * is a layer-2 provider package, so it may import `@hobo/core` and nothing else
 * HoBo — `@hobo/yards` (layer 3) is the package that parses these rows into a
 * canonical, deduplicated set. The rows are sorted by
 * `(profile, productId, connectivityId)`, the same canonical order
 * `parseYardBindings` imposes, so the hand-off is byte-stable.
 *
 * Determinism: no clock, no randomness, no environment reads. Two calls with
 * the same options are deep-equal.
 *
 * HONEST SCOPE — what deploys: unlike the SaaS providers in this repo, this
 * package does reach a real apiserver — `provisionWorkload` in `./driver.ts`
 * creates a Namespace, a Deployment and a Service through an injected
 * transport, and `./resolvers.ts` reconciles built-in objects one at a time.
 * What is still true is that no Resource Definitions are registered for the
 * `kubernetes.*` product ids, so a deploy attempted through the *Yard* fails
 * closed at resolution (`YARD_BINDING_PRODUCT_UNKNOWN`) until they land, and
 * every test here runs against an injected fake transport rather than a live
 * cluster. Eight of the nine catalogued products have resolvers; the ninth is
 * the Secret, for the reason `./slots.ts` gives.
 */

import type { CapabilitySlot, SlotBinding } from "@hobo/core";
import type { JsonObject } from "./json.js";

import { DEFAULT_REGIONS } from "./manifest.js";
import {
	cronJob,
	daemonSet,
	deployment,
	deploymentWorker,
	ingress,
	job,
	persistentVolumeClaim,
	secret,
	service,
	statefulSet,
	statefulSetWorker,
} from "./slots.js";

/** Allocatable options per capability slot; a slot may hold several. */
export type KubernetesSlotCatalog = Readonly<
	Partial<Record<CapabilitySlot, readonly SlotBinding[]>>
>;

/** Row shape `@hobo/yards` parses (`YardBindingInput`), without importing it. */
export interface KubernetesYardBindingRow {
	readonly profile: string;
	readonly productId?: string;
	readonly connectivityId?: string;
	readonly properties: JsonObject;
}

/** Raw Yard shape: provider, topology labels, and the allocatable row set. */
export interface KubernetesYardSpec {
	readonly provider: "kubernetes";
	readonly regions: readonly string[];
	readonly bindings: readonly KubernetesYardBindingRow[];
}

export interface KubernetesYardSpecOptions {
	readonly regions?: readonly string[];
}

/**
 * Everything the Kubernetes factories can allocate, grouped by slot.
 *
 * Several entries per slot is the normal case here, because a cluster really
 * does offer several distinct controllers for the same capability and a
 * workload picks between them for reasons only it knows. `web` holds a
 * Deployment and a StatefulSet — stable network identity and per-replica
 * storage are what a workload chooses the latter *for*. `service` holds five,
 * including a DaemonSet, whose one-pod-per-node placement no other controller
 * provides. `api` holds a Service and an Ingress: in-cluster addressing that
 * always works, and external routing that works only when a controller is
 * installed. Selection sorts all of that out per resource; this module does
 * not.
 */
export const KUBERNETES_DEFAULT_BINDINGS: KubernetesSlotCatalog = Object.freeze(
	{
		web: Object.freeze([deployment(), statefulSet()]),
		api: Object.freeze([service(), ingress()]),
		service: Object.freeze([
			deploymentWorker(),
			statefulSetWorker(),
			daemonSet(),
			job(),
			cronJob(),
		]),
		bucket: Object.freeze([persistentVolumeClaim()]),
		secretRef: Object.freeze([secret()]),
	},
);

/**
 * The default Kubernetes Yard as raw rows. `regions` defaults to the
 * provider's published topology labels; the catalog is not narrowed by them,
 * because a Yard declares what the provider can allocate, not what a
 * particular zone happens to offer.
 */
export function kubernetesYardSpec(
	options?: KubernetesYardSpecOptions,
): KubernetesYardSpec {
	return Object.freeze({
		provider: "kubernetes",
		regions: Object.freeze([...(options?.regions ?? DEFAULT_REGIONS)]),
		bindings: toRows(KUBERNETES_DEFAULT_BINDINGS),
	});
}

/**
 * Flattens the slot catalog into the canonical row order
 * `(profile, productId, connectivityId)` — the same order `@hobo/yards`
 * imposes, so a round-trip through it does not reshuffle the set. The slot
 * itself is not a row field: rows key on the capability profile.
 */
function toRows(
	catalog: KubernetesSlotCatalog,
): readonly KubernetesYardBindingRow[] {
	const rows: KubernetesYardBindingRow[] = [];
	for (const bindings of Object.values(catalog)) {
		for (const binding of bindings ?? []) {
			rows.push(
				Object.freeze({
					profile: binding.profile,
					...(binding.productId !== undefined
						? { productId: binding.productId }
						: undefined),
					...(binding.connectivityId !== undefined
						? { connectivityId: binding.connectivityId }
						: undefined),
					properties: binding.properties,
				}),
			);
		}
	}
	rows.sort(
		(left, right) =>
			compare(left.profile, right.profile) ||
			compare(left.productId ?? "", right.productId ?? "") ||
			compare(left.connectivityId ?? "", right.connectivityId ?? ""),
	);
	return Object.freeze(rows);
}

/** Code-unit comparison: locale-independent so ordering is reproducible. */
function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
