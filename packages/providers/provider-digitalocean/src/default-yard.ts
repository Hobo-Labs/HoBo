/**
 * The default DigitalOcean Yard catalog: what DigitalOcean *can* allocate, per
 * slot.
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
 * factories `./slots.ts` ships. Two slots the hyperscaler catalogs carry are
 * *absent* rather than filled with a near-miss: DigitalOcean sells no
 * first-party queue and no first-party secret store, so `queue`, `topic` and
 * `secretRef` have no rows. An empty slot is a gap an author can see; a row
 * pointing at a product that does not exist is a portability lie.
 *
 * `digitaloceanYardSpec()` emits raw row-shaped data rather than a `Yard`: this
 * is a layer-2 provider package, so it may import `@hobo/core` and nothing else
 * HoBo — `@hobo/yards` (layer 3) is the package that parses these rows into a
 * canonical, deduplicated set. The rows are sorted by
 * `(profile, productId, connectivityId)`, the same canonical order
 * `parseYardBindings` imposes, so the hand-off is byte-stable.
 *
 * Determinism: no clock, no randomness, no environment reads. Two calls with
 * the same options are deep-equal.
 *
 * HONEST SCOPE — what deploys: this package registers no Resource Definitions
 * for the `digitalocean.*` product ids, so a deploy attempted against this Yard
 * fails closed at resolution (`YARD_BINDING_PRODUCT_UNKNOWN`) until definitions
 * land. It does ship resolvers, but for 12 of the 16 ids only
 * (`DIGITALOCEAN_RESOLVED_PRODUCT_IDS`), and those are proven against an
 * injected fake transport — no live DigitalOcean call has been made from this
 * repo.
 */
import type { CapabilitySlot, SlotBinding } from "@hobo/core";
import { type JsonObject, parseJsonObject } from "./json.js";

import { DEFAULT_REGIONS } from "./manifest.js";
import {
	appPlatform,
	blockStorage,
	droplet,
	dropletWorker,
	functions,
	kubernetesCluster,
	loadBalancer,
	managed,
	managedValkey,
	spaces,
} from "./slots.js";

/** Allocatable options per capability slot; a slot may hold several. */
export type DigitalOceanSlotCatalog = Readonly<
	Partial<Record<CapabilitySlot, readonly SlotBinding[]>>
>;

/** Row shape `@hobo/yards` parses (`YardBindingInput`), without importing it. */
export interface DigitalOceanYardBindingRow {
	readonly profile: string;
	readonly productId?: string;
	readonly connectivityId?: string;
	readonly properties: JsonObject;
}

/** Raw Yard shape: provider, regions, and the allocatable row set. */
export interface DigitalOceanYardSpec {
	readonly provider: "digitalocean";
	readonly regions: readonly string[];
	readonly bindings: readonly DigitalOceanYardBindingRow[];
}

export interface DigitalOceanYardSpecOptions {
	readonly regions?: readonly string[];
}

/**
 * Everything the DigitalOcean factories can allocate, grouped by slot. Several
 * entries per slot are the normal case, not a conflict to be resolved here:
 * DigitalOcean really does host a web capability on App Platform, a Droplet and
 * a DOKS node pool, and really does satisfy `data` with PostgreSQL, MySQL,
 * MongoDB and OpenSearch.
 *
 * `web` mixes two profiles on purpose. `appPlatform.staticSite()` satisfies the
 * narrower `web.static/v1`, the other three satisfy `web.hosted/v1`; a workload
 * that only needs static hosting can match either, and one that needs a running
 * server matches only the hosted rows.
 */
export const DIGITALOCEAN_DEFAULT_BINDINGS: DigitalOceanSlotCatalog =
	Object.freeze({
		web: Object.freeze([
			appPlatform.service(),
			appPlatform.staticSite(),
			droplet(),
			kubernetesCluster(),
		]),
		api: Object.freeze([loadBalancer()]),
		service: Object.freeze([
			appPlatform.worker(),
			appPlatform.job(),
			functions(),
			dropletWorker(),
		]),
		data: Object.freeze([
			managed.postgres(),
			managed.mysql(),
			managed.mongodb(),
			managed.opensearch(),
		]),
		kv: Object.freeze([managedValkey()]),
		bucket: Object.freeze([spaces(), blockStorage()]),
	});

/**
 * The default DigitalOcean Yard as raw rows. `regions` defaults to the
 * provider's published regions; the catalog is not narrowed by region, because
 * a Yard declares what the provider can allocate, not what a particular region
 * happens to offer.
 */
export function digitaloceanYardSpec(
	options?: DigitalOceanYardSpecOptions,
): DigitalOceanYardSpec {
	return Object.freeze({
		provider: "digitalocean",
		regions: Object.freeze([...(options?.regions ?? DEFAULT_REGIONS)]),
		bindings: toRows(DIGITALOCEAN_DEFAULT_BINDINGS),
	});
}

/**
 * Flattens the slot catalog into the canonical row order
 * `(profile, productId, connectivityId)` — the same order `@hobo/yards`
 * imposes, so a round-trip through it does not reshuffle the set. The slot
 * itself is not a row field: rows key on the capability profile.
 */
function toRows(
	catalog: DigitalOceanSlotCatalog,
): readonly DigitalOceanYardBindingRow[] {
	const rows: DigitalOceanYardBindingRow[] = [];
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
					properties: parseJsonObject(JSON.stringify(binding.properties)),
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
