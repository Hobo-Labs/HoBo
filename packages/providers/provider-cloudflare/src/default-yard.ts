/**
 * The default exported Cloudflare Yard: a catalog of what CAN be allocated.
 *
 * Read the semantics carefully, because the obvious misreading makes the file
 * wrong. A Yard declares what a provider **can** allocate — it is not a record
 * of what an app uses, not a mapping already made, and not a pool of live
 * resources. So a capability slot here may list *several* offerings, and
 * selection (ADR-0151, hard gates then lexicographic ordering) picks among them
 * later against the app's actual capability requirement. `web` listing both
 * Pages and Workers is not an unresolved ambiguity to be tidied away; it is the
 * accurate statement that Cloudflare can serve a web capability either way.
 *
 * Every row is built from the `./slots.js` factories rather than hand-written,
 * so the catalog cannot drift from the product ids the rest of the package
 * emits, and every row passes core's `slotBinding()` parse boundary (credential
 * screening, JSON-safety, canonical key order, freezing).
 *
 * Layering: this is a layer-2 adapter, so it may not import `@hobo/yards`
 * (layer 3). It therefore returns plain `YardBindingInput`-shaped rows plus the
 * provider and region metadata, and `@hobo/yards` composes them — the
 * dependency points inward, as it must.
 *
 * Determinism: rows are sorted by `(profile, productId)` and frozen, so two
 * calls with the same options are deep-equal. No clock, no randomness.
 *
 * HONEST SCOPE: this catalog covers exactly the six slot factories in
 * `./slots.js`. Cloudflare can serve capabilities this catalog does not offer
 * (`topic`, `secretRef`, `webhook`, and a dedicated `api` row among them);
 * their absence means no factory emits them yet, not that Cloudflare cannot do
 * them. Listing a row is also not evidence that a matching Resource Definition
 * is registered — that is checked at resolution time and refused with
 * `YARD_BINDING_PRODUCT_UNKNOWN` if it is not.
 */

import { type CapabilitySlot, type SlotBinding, slotBinding } from "@hobo/core";

import { CLOUDFLARE_PROVIDER_TARGET } from "./hello-bindle.js";
import { type JsonObject, parseJsonObject } from "./json.js";
import { cronTriggers, d1, kv, pages, queues, r2, workers } from "./slots.js";

/**
 * `YardBindingInput` as `@hobo/yards` defines it, restated structurally so this
 * layer-2 package can produce the rows without importing layer 3. Only the
 * fields this catalog authors are present; the rest are optional there too.
 */
export interface CloudflareYardBindingRow {
	readonly profile: string;
	readonly productId: string;
	readonly properties: JsonObject;
}

export type CloudflareYardOfferings = Readonly<
	Partial<Record<CapabilitySlot, readonly SlotBinding[]>>
>;

export interface CloudflareYardCatalog {
	readonly name: string;
	readonly provider: string;
	readonly regions: readonly string[];
	readonly offerings: CloudflareYardOfferings;
	readonly bindings: readonly CloudflareYardBindingRow[];
}

/** What `@hobo/yards` needs to build the Yard: provider, regions, rows. */
export interface CloudflareYardSpec {
	readonly provider: string;
	readonly regions: readonly string[];
	readonly bindings: readonly CloudflareYardBindingRow[];
}

export interface CloudflareYardOptions {
	readonly name?: string;
	readonly regions?: readonly string[];
}

export const CLOUDFLARE_DEFAULT_YARD_NAME = "cloudflare";
export const CLOUDFLARE_DEFAULT_REGIONS = Object.freeze(["global"] as const);

function alsoServes(
	slot: CapabilitySlot,
	slotExemplar: SlotBinding,
	offering: SlotBinding,
): SlotBinding {
	return slotBinding({
		slot,
		profile: slotExemplar.profile,
		...(offering.productId !== undefined
			? { productId: offering.productId }
			: undefined),
		...(offering.connectivityId !== undefined
			? { connectivityId: offering.connectivityId }
			: undefined),
		properties: offering.properties,
	});
}

function buildCatalog(): readonly SlotBinding[] {
	const web = pages();
	return Object.freeze([
		r2(),
		d1(),
		kv(),
		queues(),
		cronTriggers(),
		workers(),
		web,
		alsoServes("web", web, workers({ workersDev: true })),
	]);
}

function groupBySlot(
	bindings: readonly SlotBinding[],
): CloudflareYardOfferings {
	const grouped = new Map<CapabilitySlot, SlotBinding[]>();
	for (const binding of bindings) {
		const existing = grouped.get(binding.slot);
		if (existing === undefined) {
			grouped.set(binding.slot, [binding]);
			continue;
		}
		existing.push(binding);
	}
	const out: Partial<Record<CapabilitySlot, readonly SlotBinding[]>> = {};
	for (const slot of [...grouped.keys()].sort()) {
		out[slot] = Object.freeze(grouped.get(slot) ?? []);
	}
	return Object.freeze(out);
}

function toRow(binding: SlotBinding): CloudflareYardBindingRow {
	if (binding.productId === undefined) {
		throw new TypeError(
			"cloudflare yard catalog: a slot binding without a productId cannot become a Yard row",
		);
	}
	return Object.freeze({
		profile: binding.profile,
		productId: binding.productId,
		properties: parseJsonObject(JSON.stringify(binding.properties)),
	});
}

function compareRows(
	left: CloudflareYardBindingRow,
	right: CloudflareYardBindingRow,
): number {
	if (left.profile !== right.profile) {
		return left.profile < right.profile ? -1 : 1;
	}
	if (left.productId === right.productId) return 0;
	return left.productId < right.productId ? -1 : 1;
}

const CATALOG = buildCatalog();

const OFFERINGS = groupBySlot(CATALOG);

export const CLOUDFLARE_DEFAULT_BINDINGS: readonly CloudflareYardBindingRow[] =
	Object.freeze(CATALOG.map(toRow).sort(compareRows));

function resolveRegions(
	regions: readonly string[] | undefined,
): readonly string[] {
	if (regions === undefined) return CLOUDFLARE_DEFAULT_REGIONS;
	if (!Array.isArray(regions)) {
		throw new TypeError("cloudflare yard regions must be an array of strings");
	}
	for (const region of regions) {
		if (region.trim().length === 0) {
			throw new TypeError(
				"cloudflare yard regions must be non-empty strings; a blank region would silently widen residency",
			);
		}
	}
	return Object.freeze([...new Set(regions)].sort());
}

function resolveName(name: string | undefined): string {
	if (name === undefined) return CLOUDFLARE_DEFAULT_YARD_NAME;
	if (name.trim().length === 0) {
		throw new TypeError("cloudflare yard name must be a non-empty string");
	}
	return name;
}

export function cloudflareYard(
	options?: CloudflareYardOptions,
): CloudflareYardCatalog {
	return Object.freeze({
		name: resolveName(options?.name),
		provider: CLOUDFLARE_PROVIDER_TARGET,
		regions: resolveRegions(options?.regions),
		offerings: OFFERINGS,
		bindings: CLOUDFLARE_DEFAULT_BINDINGS,
	});
}

/**
 * The minimal shape `@hobo/yards` consumes: `yard(name, cloudflareYardSpec())`
 * builds the default Cloudflare Yard without this package importing layer 3.
 */
export function cloudflareYardSpec(
	options?: CloudflareYardOptions,
): CloudflareYardSpec {
	const catalog = cloudflareYard(options);
	return Object.freeze({
		provider: catalog.provider,
		regions: catalog.regions,
		bindings: catalog.bindings,
	});
}
