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

export type KubernetesSlotCatalog = Readonly<
	Partial<Record<CapabilitySlot, readonly SlotBinding[]>>
>;

export interface KubernetesYardBindingRow {
	readonly profile: string;
	readonly productId?: string;
	readonly connectivityId?: string;
	readonly properties: JsonObject;
}

export interface KubernetesYardSpec {
	readonly provider: "kubernetes";
	readonly regions: readonly string[];
	readonly bindings: readonly KubernetesYardBindingRow[];
}

export interface KubernetesYardSpecOptions {
	readonly regions?: readonly string[];
}

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

export function kubernetesYardSpec(
	options?: KubernetesYardSpecOptions,
): KubernetesYardSpec {
	return Object.freeze({
		provider: "kubernetes",
		regions: Object.freeze([...(options?.regions ?? DEFAULT_REGIONS)]),
		bindings: toRows(KUBERNETES_DEFAULT_BINDINGS),
	});
}

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

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
