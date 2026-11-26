/**
 * The default Hetzner Yard catalog: what Hetzner *can* allocate, per slot.
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
 * factories `./slots.ts` ships, and it is deliberately narrow because Hetzner
 * is deliberately narrow. Five slots the hyperscaler catalogs carry are absent
 * rather than filled with a near-miss: Hetzner sells no managed database, no
 * managed cache, no managed queue, no managed topic and no managed secret
 * store, so `data`, `kv`, `queue`, `topic` and `secretRef` have no rows. An
 * empty slot is a gap an author can see; a row pointing at "Postgres you
 * install yourself on a Cloud Server" would be a portability lie.
 *
 * `hetznerYardSpec()` emits raw row-shaped data rather than a `Yard`: this is a
 * layer-2 provider package, so it may import `@hobo/core` and nothing else HoBo
 * — `@hobo/yards` (layer 3) is the package that parses these rows into a
 * canonical, deduplicated set. The rows are sorted by
 * `(profile, productId, connectivityId)`, the same canonical order
 * `parseYardBindings` imposes, so the hand-off is byte-stable.
 *
 * Determinism: no clock, no randomness, no environment reads. Two calls with
 * the same options are deep-equal.
 *
 * HONEST SCOPE — what deploys: this package registers no Resource Definitions
 * for the `hetzner.*` product ids, so a deploy attempted against this Yard
 * fails closed at resolution (`YARD_BINDING_PRODUCT_UNKNOWN`) until definitions
 * land. It does ship resolvers, but for 4 of the 5 ids only
 * (`HETZNER_RESOLVED_PRODUCT_IDS`), and those are proven against an injected
 * fake transport — no live Hetzner call has been made from this repo.
 */
import type { CapabilitySlot, SlotBinding } from "@hobo/core";

import { type JsonObject, parseJsonObject } from "./json.js";
import { DEFAULT_REGIONS } from "./manifest.js";
import {
	cloudServer,
	cloudServerWorker,
	loadBalancer,
	objectStorage,
	storageBox,
	volume,
} from "./slots.js";

/** Allocatable options per capability slot; a slot may hold several. */
export type HetznerSlotCatalog = Readonly<
	Partial<Record<CapabilitySlot, readonly SlotBinding[]>>
>;

/** Row shape `@hobo/yards` parses (`YardBindingInput`), without importing it. */
export interface HetznerYardBindingRow {
	readonly profile: string;
	readonly productId?: string;
	readonly connectivityId?: string;
	readonly properties: JsonObject;
}

/** Raw Yard shape: provider, regions, and the allocatable row set. */
export interface HetznerYardSpec {
	readonly provider: "hetzner";
	readonly regions: readonly string[];
	readonly bindings: readonly HetznerYardBindingRow[];
}

export interface HetznerYardSpecOptions {
	readonly regions?: readonly string[];
}

/**
 * Everything the Hetzner factories can allocate, grouped by slot.
 *
 * `bucket` holds three entries under three profiles on purpose, and each one is
 * the most specific profile that is true of it: Object Storage is
 * `bucket.s3-compatible/v1`, a Storage Box is the metadata-carrying share
 * `bucket.file-storage/v1`, and a Volume is a mounted `bucket.filesystem/v1`.
 * All three refine `bucket.object/v1`, so a workload asking for the general
 * profile matches all three and selection picks; a workload that needs S3
 * semantics matches only the first.
 */
export const HETZNER_DEFAULT_BINDINGS: HetznerSlotCatalog = Object.freeze({
	web: Object.freeze([cloudServer()]),
	api: Object.freeze([loadBalancer()]),
	service: Object.freeze([cloudServerWorker()]),
	bucket: Object.freeze([objectStorage(), storageBox(), volume()]),
});

/**
 * The default Hetzner Yard as raw rows. `regions` defaults to the provider's
 * published locations; the catalog is not narrowed by region, because a Yard
 * declares what the provider can allocate, not what a particular location
 * happens to offer.
 */
export function hetznerYardSpec(
	options?: HetznerYardSpecOptions,
): HetznerYardSpec {
	return Object.freeze({
		provider: "hetzner",
		regions: Object.freeze([...(options?.regions ?? DEFAULT_REGIONS)]),
		bindings: toRows(HETZNER_DEFAULT_BINDINGS),
	});
}

/**
 * Flattens the slot catalog into the canonical row order
 * `(profile, productId, connectivityId)` — the same order `@hobo/yards`
 * imposes, so a round-trip through it does not reshuffle the set. The slot
 * itself is not a row field: rows key on the capability profile.
 */
function toRows(catalog: HetznerSlotCatalog): readonly HetznerYardBindingRow[] {
	const rows: HetznerYardBindingRow[] = [];
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
