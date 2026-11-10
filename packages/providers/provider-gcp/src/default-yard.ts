/**
 * The default Google Cloud Yard catalog: what GCP *can* allocate, per slot.
 *
 * A Yard declares allocatable capacity. It is not a mapping, not a pool, not a
 * selection, and not a record of what an app uses — so a slot commonly carries
 * several entries. `web` here lists Cloud Run, App Engine and a Cloud Storage
 * site side by side, because all three can host a web capability on GCP; which
 * one a given app gets is decided later by selection (ADR-0151), against the
 * requirements the app actually states. Collapsing a slot to one entry would
 * quietly make this module the selector, which is exactly the decision the Yard
 * is not allowed to take.
 *
 * `gcpYardSpec()` emits raw row-shaped data rather than a `Yard`: this is a
 * layer-2 provider package, so it may import `@hobo/core` and nothing else
 * HoBo — `@hobo/yards` (layer 3) is the package that parses these rows into a
 * canonical, deduplicated set. The rows are sorted by
 * `(profile, productId, connectivityId)`, the same canonical order
 * `parseYardBindings` imposes, so the hand-off is byte-stable.
 *
 * Determinism: no clock, no randomness, no environment reads. Two calls with
 * the same options are deep-equal.
 *
 * HONEST SCOPE: this is the catalog — what GCP is *able* to allocate
 * (ADR-0157 decision 1), not what is allocated. This package registers no
 * Resource Definitions for the `gcp.*` product ids below, so a deploy still
 * fails closed at resolution (`YARD_BINDING_PRODUCT_UNKNOWN`) until definitions
 * land. It does now ship Google REST resolvers, but for 8 of the 14 ids only
 * (`GCP_RESOLVED_PRODUCT_IDS`), and those are proven against an injected fake
 * transport, never a live project. A row in this Yard is not a promise that
 * the row deploys.
 */
import type { CapabilitySlot, SlotBinding } from "@hobo/core";

import { type JsonObject, parseJsonObject } from "./json.js";
import { DEFAULT_REGIONS } from "./manifest.js";
import {
	apiGateway,
	appEngine,
	cloudFunctions,
	cloudRun,
	cloudRunJob,
	cloudSqlMysql,
	cloudSqlPostgres,
	cloudStorage,
	cloudStorageSite,
	cloudTasks,
	computeEngineInstance,
	firestore,
	memorystoreRedis,
	persistentDisk,
	pubsub,
	secretManager,
} from "./slots.js";

/** Allocatable options per capability slot; a slot may hold several. */
export type GcpSlotCatalog = Readonly<
	Partial<Record<CapabilitySlot, readonly SlotBinding[]>>
>;

/** Row shape `@hobo/yards` parses (`YardBindingInput`), without importing it. */
export interface GcpYardBindingRow {
	readonly profile: string;
	readonly productId?: string;
	readonly connectivityId?: string;
	readonly properties: JsonObject;
}

/** Raw Yard shape: provider, regions, and the allocatable row set. */
export interface GcpYardSpec {
	readonly provider: "gcp";
	readonly regions: readonly string[];
	readonly bindings: readonly GcpYardBindingRow[];
}

export interface GcpYardSpecOptions {
	readonly regions?: readonly string[];
}

/**
 * Everything GCP can allocate, grouped by slot. Several entries per slot are
 * the normal case, not a conflict to be resolved here.
 */
export const GCP_DEFAULT_BINDINGS: GcpSlotCatalog = Object.freeze({
	web: Object.freeze([cloudRun(), appEngine(), cloudStorageSite()]),
	api: Object.freeze([apiGateway()]),
	service: Object.freeze([
		computeEngineInstance(),
		cloudFunctions(),
		cloudRunJob(),
	]),
	data: Object.freeze([cloudSqlPostgres(), cloudSqlMysql(), firestore()]),
	kv: Object.freeze([memorystoreRedis()]),
	bucket: Object.freeze([persistentDisk(), cloudStorage()]),
	queue: Object.freeze([cloudTasks()]),
	topic: Object.freeze([pubsub()]),
	secretRef: Object.freeze([secretManager()]),
});

/**
 * The default GCP Yard as raw rows. `regions` defaults to the provider's
 * published regions; the catalog is not narrowed by region, because a Yard
 * declares what the provider can allocate, not what a particular region
 * happens to offer.
 */
export function gcpYardSpec(options?: GcpYardSpecOptions): GcpYardSpec {
	return Object.freeze({
		provider: "gcp",
		regions: Object.freeze([...(options?.regions ?? DEFAULT_REGIONS)]),
		bindings: toRows(GCP_DEFAULT_BINDINGS),
	});
}

/**
 * Flattens the slot catalog into the canonical row order
 * `(profile, productId, connectivityId)` — the same order `@hobo/yards`
 * imposes, so a round-trip through it does not reshuffle the set. The slot
 * itself is not a row field: rows key on the capability profile.
 */
function toRows(catalog: GcpSlotCatalog): readonly GcpYardBindingRow[] {
	const rows: GcpYardBindingRow[] = [];
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
