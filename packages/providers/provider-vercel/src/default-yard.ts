import type { CapabilitySlot, SlotBinding } from "@hobo/core";

import { type JsonObject, parseJsonObject } from "./json.js";
import { PROVIDER_TARGET } from "./options.js";
import {
	blob,
	cron,
	delayedQueue,
	edgeConfig,
	edgeFunction,
	gitFunction,
	project,
	queue,
	sandboxHost,
	schedule,
	staticDeployment,
	type VercelBlobSlotOptions,
	type VercelCronSlotOptions,
	type VercelEdgeConfigSlotOptions,
	type VercelEdgeFunctionSlotOptions,
	type VercelGitFunctionSlotOptions,
	type VercelProjectSlotOptions,
	type VercelQueueSlotOptions,
	type VercelSandboxHostSlotOptions,
	type VercelScheduleSlotOptions,
	type VercelStaticDeploySlotOptions,
} from "./slots.js";

export const VERCEL_DEFAULT_REGIONS = Object.freeze(["iad1"] as const);

const REGION_PATTERN = /^[a-z0-9-]+$/u;

export class VercelYardSpecError extends Error {
	readonly code: "VERCEL_YARD_REGIONS_EMPTY" | "VERCEL_YARD_REGION_INVALID";

	constructor(
		code: "VERCEL_YARD_REGIONS_EMPTY" | "VERCEL_YARD_REGION_INVALID",
		message: string,
	) {
		super(message);
		this.name = "VercelYardSpecError";
		this.code = code;
	}
}

export type VercelSlotCatalog = Readonly<
	Partial<Record<CapabilitySlot, readonly SlotBinding[]>>
>;

export interface VercelYardBindingRow {
	readonly profile: string;
	readonly productId?: string;
	readonly connectivityId?: string;
	readonly properties: JsonObject;
}

export interface VercelYardSpec {
	readonly provider: typeof PROVIDER_TARGET;
	readonly regions: readonly string[];
	readonly bindings: readonly VercelYardBindingRow[];
}

export interface VercelYardSpecOptions {
	readonly regions?: readonly string[];
	readonly project?: VercelProjectSlotOptions;
	readonly staticDeployment?: VercelStaticDeploySlotOptions;
	readonly edgeFunction?: VercelEdgeFunctionSlotOptions;
	readonly blob?: VercelBlobSlotOptions;
	readonly edgeConfig?: VercelEdgeConfigSlotOptions;
	readonly gitFunction?: VercelGitFunctionSlotOptions;
	readonly queue?: VercelQueueSlotOptions;
	readonly schedule?: VercelScheduleSlotOptions;
	readonly cron?: VercelCronSlotOptions;
	readonly sandboxHost?: VercelSandboxHostSlotOptions;
}

export const VERCEL_DEFAULT_BINDINGS: VercelSlotCatalog = Object.freeze({
	web: Object.freeze([staticDeployment()]),
	service: Object.freeze([edgeFunction()]),
	bucket: Object.freeze([blob()]),
	kv: Object.freeze([edgeConfig()]),
});

export function vercelYardSpec(
	options: VercelYardSpecOptions = {},
): VercelYardSpec {
	return Object.freeze({
		provider: PROVIDER_TARGET,
		regions: canonicalRegions(options.regions),
		bindings: vercelYardRows(vercelSlotCatalog(options)),
	});
}

export function vercelSlotCatalog(
	options: VercelYardSpecOptions = {},
): VercelSlotCatalog {
	return Object.freeze({
		web: Object.freeze([
			staticDeployment(options.staticDeployment ?? {}),
			...(options.project ? [project(options.project)] : []),
		]),
		service: Object.freeze([
			edgeFunction(options.edgeFunction ?? {}),
			...(options.schedule ? [schedule(options.schedule)] : []),
			...(options.cron ? [cron(options.cron)] : []),
			...(options.sandboxHost ? [sandboxHost(options.sandboxHost)] : []),
		]),
		...(options.gitFunction
			? { api: Object.freeze([gitFunction(options.gitFunction)]) }
			: undefined),
		...(options.queue
			? {
					queue: Object.freeze([
						queue(options.queue),
						delayedQueue(options.queue),
					]),
				}
			: undefined),
		bucket: Object.freeze([blob(options.blob ?? {})]),
		kv: Object.freeze([edgeConfig(options.edgeConfig ?? {})]),
	});
}

export function vercelYardRows(
	catalog: VercelSlotCatalog,
): readonly VercelYardBindingRow[] {
	const rows: VercelYardBindingRow[] = [];
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

function canonicalRegions(
	regions: readonly string[] | undefined,
): readonly string[] {
	const source = regions ?? VERCEL_DEFAULT_REGIONS;
	if (source.length === 0) {
		throw new VercelYardSpecError(
			"VERCEL_YARD_REGIONS_EMPTY",
			"a Vercel Yard must declare at least one region it can allocate in; omit regions to take the documented default instead of passing an empty list",
		);
	}
	for (const region of source) {
		if (!REGION_PATTERN.test(region)) {
			throw new VercelYardSpecError(
				"VERCEL_YARD_REGION_INVALID",
				`region ${JSON.stringify(region)} is not a Vercel region id (lowercase letters, digits, and hyphens, for example iad1)`,
			);
		}
	}
	return Object.freeze([...new Set(source)].sort());
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
