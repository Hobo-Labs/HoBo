/**
 * The default Hostinger Yard catalog: what Hostinger *can* allocate, per slot.
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
 * factories `./slots.ts` ships, and it is deliberately narrow because Hostinger
 * is a hosting-plan business rather than an infrastructure primitives business.
 * Four slots the hyperscaler catalogs carry are absent rather than filled with
 * a near-miss: Hostinger sells no object store, no managed cache, no managed
 * queue and no managed secret store, so `bucket`, `kv`, `queue`, `topic` and
 * `secretRef` have no rows. An empty slot is a gap an author can see; a row
 * pointing at "an S3 bucket you rent somewhere else" would be a portability
 * lie.
 *
 * `hostingerYardSpec()` emits raw row-shaped data rather than a `Yard`: this is a
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
 * for the `hostinger.*` product ids, so a deploy attempted against this Yard
 * fails closed at resolution (`YARD_BINDING_PRODUCT_UNKNOWN`) until definitions
 * land. It does ship bearer-token resolvers, but for 2 of the 5 ids only
 * (`HOSTINGER_RESOLVED_PRODUCT_IDS`), and those *adopt and converge* an
 * instance you already bought rather than creating one — allocation on this
 * provider is a billing order, which no resolver here will place. They are
 * proven against an injected fake transport; no live Hostinger call has been
 * made from this repo.
 */
import type { CapabilitySlot, SlotBinding } from "@hobo/core";

import { type JsonObject, parseJsonObject } from "./json.js";
import { DEFAULT_REGIONS } from "./manifest.js";
import {
	dnsZone,
	mysql,
	staticSite,
	vps,
	vpsWorker,
	webHosting,
} from "./slots.js";

/** Allocatable options per capability slot; a slot may hold several. */
export type HostingerSlotCatalog = Readonly<
	Partial<Record<CapabilitySlot, readonly SlotBinding[]>>
>;

/** Row shape `@hobo/yards` parses (`YardBindingInput`), without importing it. */
export interface HostingerYardBindingRow {
	readonly profile: string;
	readonly productId?: string;
	readonly connectivityId?: string;
	readonly properties: JsonObject;
}

/** Raw Yard shape: provider, regions, and the allocatable row set. */
export interface HostingerYardSpec {
	readonly provider: "hostinger";
	readonly regions: readonly string[];
	readonly bindings: readonly HostingerYardBindingRow[];
}

export interface HostingerYardSpecOptions {
	readonly regions?: readonly string[];
}

/**
 * Everything the Hostinger factories can allocate, grouped by slot.
 *
 * `web` holds three entries under two profiles on purpose. `staticSite()`
 * satisfies the narrower `web.static/v1`; a VPS and shared/cloud web hosting
 * both satisfy `web.hosted/v1` through genuinely different means (a machine you
 * administer versus a managed PHP origin), so both are declared and selection
 * picks against what the app actually states.
 */
export const HOSTINGER_DEFAULT_BINDINGS: HostingerSlotCatalog = Object.freeze({
	web: Object.freeze([vps(), webHosting(), staticSite()]),
	api: Object.freeze([dnsZone()]),
	service: Object.freeze([vpsWorker()]),
	data: Object.freeze([mysql()]),
});

/**
 * The default Hostinger Yard as raw rows. `regions` defaults to the provider's
 * published data centres; the catalog is not narrowed by region, because a Yard
 * declares what the provider can allocate, not what a particular data centre
 * happens to offer.
 */
export function hostingerYardSpec(
	options?: HostingerYardSpecOptions,
): HostingerYardSpec {
	return Object.freeze({
		provider: "hostinger",
		regions: Object.freeze([...(options?.regions ?? DEFAULT_REGIONS)]),
		bindings: toRows(HOSTINGER_DEFAULT_BINDINGS),
	});
}

/**
 * Flattens the slot catalog into the canonical row order
 * `(profile, productId, connectivityId)` — the same order `@hobo/yards`
 * imposes, so a round-trip through it does not reshuffle the set. The slot
 * itself is not a row field: rows key on the capability profile.
 */
function toRows(
	catalog: HostingerSlotCatalog,
): readonly HostingerYardBindingRow[] {
	const rows: HostingerYardBindingRow[] = [];
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
