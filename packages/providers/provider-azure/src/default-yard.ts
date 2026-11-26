import type { CapabilitySlot, SlotBinding } from "@hobo/core";

import { type JsonObject, parseJsonObject } from "./json.js";
import { DEFAULT_REGIONS } from "./manifest.js";
import {
	aks,
	apiManagement,
	appService,
	blobStorage,
	containerApps,
	containerAppsService,
	cosmosDb,
	cosmosTable,
	functions,
	keyVault,
	managedDisk,
	postgresFlexible,
	redisCache,
	serviceBusQueue,
	serviceBusTopic,
	sqlDatabase,
	staticWebApps,
	storageQueue,
	virtualMachine,
} from "./slots.js";

export type AzureSlotCatalog = Readonly<
	Partial<Record<CapabilitySlot, readonly SlotBinding[]>>
>;

export interface AzureYardBindingRow {
	readonly profile: string;
	readonly productId?: string;
	readonly connectivityId?: string;
	readonly properties: JsonObject;
}

export interface AzureYardSpec {
	readonly provider: "azure";
	readonly regions: readonly string[];
	readonly bindings: readonly AzureYardBindingRow[];
}

export interface AzureYardSpecOptions {
	readonly regions?: readonly string[];
}

export const AZURE_DEFAULT_BINDINGS: AzureSlotCatalog = Object.freeze({
	web: Object.freeze([staticWebApps(), appService(), containerApps(), aks()]),
	api: Object.freeze([apiManagement()]),
	service: Object.freeze([
		virtualMachine(),
		functions(),
		containerAppsService(),
	]),
	data: Object.freeze([postgresFlexible(), sqlDatabase(), cosmosDb()]),
	kv: Object.freeze([cosmosTable(), redisCache()]),
	bucket: Object.freeze([managedDisk(), blobStorage()]),
	queue: Object.freeze([storageQueue(), serviceBusQueue()]),
	topic: Object.freeze([serviceBusTopic()]),
	secretRef: Object.freeze([keyVault()]),
});

export function azureYardSpec(options?: AzureYardSpecOptions): AzureYardSpec {
	return Object.freeze({
		provider: "azure",
		regions: Object.freeze([...(options?.regions ?? DEFAULT_REGIONS)]),
		bindings: toRows(AZURE_DEFAULT_BINDINGS),
	});
}

function toRows(catalog: AzureSlotCatalog): readonly AzureYardBindingRow[] {
	const rows: AzureYardBindingRow[] = [];
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
