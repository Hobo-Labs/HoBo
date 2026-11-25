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

export type GcpSlotCatalog = Readonly<
	Partial<Record<CapabilitySlot, readonly SlotBinding[]>>
>;

export interface GcpYardBindingRow {
	readonly profile: string;
	readonly productId?: string;
	readonly connectivityId?: string;
	readonly properties: JsonObject;
}

export interface GcpYardSpec {
	readonly provider: "gcp";
	readonly regions: readonly string[];
	readonly bindings: readonly GcpYardBindingRow[];
}

export interface GcpYardSpecOptions {
	readonly regions?: readonly string[];
}

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

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
