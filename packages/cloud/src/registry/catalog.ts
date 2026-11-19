import { createHash } from "node:crypto";

import type { EventStore } from "@hobo/core";
import { defineProjection, type Projection } from "@hobo/data";
import {
	CLOUD_EVENTS,
	providerApproved,
	providerRegistered,
} from "../events.js";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../json.js";
import type { CapabilityVerdict } from "../plan-types.js";
import { collectStream } from "../store/index.js";

export interface RegistrableCapability {
	port: string;
	satisfies(req: { port: string; features?: string[] }): {
		kind: string;
		missing?: string[];
	};
	estimateCost(req: { port: string }): {
		marginalPrice: string;
		sku: string;
		unit: string;
		pricingStatus?: "unknown" | "estimate" | "verified-zero";
	};
}

export interface RegistrableProvider {
	id: string;
	regions: string[];
	capabilities: RegistrableCapability[];
	capabilityManifest(): {
		providerId: string;
		published: Record<string, string>;
		capabilities: JsonObject;
		cost: JsonObject;
	};
}

const _coreCloudProviderIsRegistrable = (
	provider: import("@hobo/core").CloudProvider,
): RegistrableProvider => provider;
void _coreCloudProviderIsRegistrable;

export interface ResourceDefinition {
	id: string;
	productId?: string;
	providerId: string;
	port: string;
	features: string[];
	regions: string[];
	specificity: number;
	priority: number;
	cost: {
		sku: string;
		unit: string;
		marginalPrice: string;
		pricingStatus?: "unknown" | "estimate" | "verified-zero";
	};
	satisfies(req: { port: string; features?: string[] }): CapabilityVerdict;
}

export interface HeldProvider {
	providerId: string;
	ports: string[];
}

export interface PlannerRegistry {
	catalogHash: string;
	definitions(): ResourceDefinition[];
	providers(): string[];
	refresh?(): Promise<void>;
	held?(): HeldProvider[];
}

function normalizeVerdict(raw: {
	kind: string;
	missing?: string[];
}): CapabilityVerdict {
	if (raw.kind === "full") return { kind: "full" };
	if (raw.kind === "partial")
		return { kind: "partial", missing: raw.missing ?? [] };
	return { kind: "none" };
}

function parsePricingStatus(
	value: JsonValue | undefined,
): ResourceDefinition["cost"]["pricingStatus"] {
	if (value === undefined) return undefined;
	if (value === "unknown" || value === "estimate" || value === "verified-zero")
		return value;
	return "unknown";
}

function catalogHashOf(definitions: ResourceDefinition[]): string {
	const summary = definitions
		.map((d) => ({
			id: d.id,
			productId: d.productId,
			providerId: d.providerId,
			port: d.port,
			features: [...d.features].sort(),
			regions: [...d.regions].sort(),
			specificity: d.specificity,
			priority: d.priority,
			sku: d.cost.sku,
			unit: d.cost.unit,
			marginalPrice: d.cost.marginalPrice,
			pricingStatus: d.cost.pricingStatus,
		}))
		.sort((a, b) => a.id.localeCompare(b.id));
	const digest = createHash("sha256")
		.update(JSON.stringify(summary))
		.digest("hex");
	return `sha256:${digest}`;
}

export function definitionsFor(
	provider: RegistrableProvider,
): ResourceDefinition[] {
	const manifest = provider.capabilityManifest();
	const capsArray =
		(manifest.capabilities as { capabilities?: Array<JsonObject> })
			.capabilities ?? [];
	const costFacts =
		(manifest.cost as { facts?: Array<JsonObject> }).facts ?? [];

	return provider.capabilities.map((capability) => {
		const manifestEntry = capsArray.find(
			(entry) => entry.port === capability.port,
		);
		const costFact = costFacts.find((fact) => fact.port === capability.port);
		const estimate = capability.estimateCost({ port: capability.port });
		const features = Array.isArray(manifestEntry?.features)
			? manifestEntry.features.filter(isJsonString)
			: [];
		const regions = Array.isArray(manifestEntry?.regions)
			? manifestEntry.regions.filter(isJsonString)
			: [...provider.regions];

		return {
			id: `${provider.id}:${capability.port}`,
			...(isJsonString(manifestEntry?.productId) &&
			manifestEntry.productId.length > 0
				? { productId: manifestEntry.productId }
				: undefined),
			providerId: provider.id,
			port: capability.port,
			features,
			regions,
			specificity: 10,
			priority: 0,
			cost: {
				sku: (costFact?.sku as string) ?? estimate.sku,
				unit: (costFact?.unit as string) ?? estimate.unit,
				marginalPrice:
					(costFact?.marginalPrice as string) ?? estimate.marginalPrice,
				pricingStatus: parsePricingStatus(
					costFact?.pricingStatus ??
						estimate.pricingStatus ??
						manifest.cost.pricingStatus,
				),
			},
			satisfies: (req) => normalizeVerdict(capability.satisfies(req)),
		};
	});
}

export function createRegistryFromProviders(
	providers: RegistrableProvider[],
): PlannerRegistry {
	const definitions = providers.flatMap(definitionsFor);
	const hash = catalogHashOf(definitions);
	const providerIds = [...new Set(providers.map((p) => p.id))];
	return {
		catalogHash: hash,
		definitions: () => definitions.map((d) => ({ ...d })),
		providers: () => [...providerIds],
	};
}

export function registerProviderFact(provider: RegistrableProvider) {
	const definitions = definitionsFor(provider).map((d) => ({
		id: d.id,
		...(d.productId ? { productId: d.productId } : undefined),
		providerId: d.providerId,
		port: d.port,
		features: d.features,
		regions: d.regions,
		specificity: d.specificity,
		priority: d.priority,
		cost: d.cost,
	}));
	const manifest = provider.capabilityManifest();
	const indexDoc =
		manifest.published["/.well-known/capability-manifest/index.json"] ?? "";
	const manifestIndexDigest = `sha256:${createHash("sha256").update(indexDoc).digest("hex")}`;
	return providerRegistered({
		providerId: provider.id,
		definitions,
		manifestIndexDigest,
	});
}

export function approveProviderFact(providerId: string, approvedBy?: string) {
	return providerApproved(
		approvedBy !== undefined ? { providerId, approvedBy } : { providerId },
	);
}

function negotiateFromEntry(
	port: string,
	features: readonly string[],
): ResourceDefinition["satisfies"] {
	return (req) => {
		if (req.port !== port) return { kind: "none" };
		const missing = (req.features ?? []).filter(
			(feature) => !features.includes(feature),
		);
		if (missing.length === 0) return { kind: "full" };
		return { kind: "partial", missing };
	};
}

export function parseRegisteredDefinitions<T>(data: T): ResourceDefinition[] {
	if (data === null || !isJsonObject(data)) return [];
	const body = data;
	if (!isJsonString(body.providerId) || body.providerId.length === 0) return [];
	if (!Array.isArray(body.definitions)) return [];

	const parsed: ResourceDefinition[] = [];
	for (const raw of body.definitions) {
		if (raw === null || !isJsonObject(raw)) continue;
		const rec = raw;
		if (!isJsonString(rec.port) || rec.port.length === 0) continue;
		const features = Array.isArray(rec.features)
			? rec.features.filter((f): f is string => isJsonString(f))
			: [];
		const regions = Array.isArray(rec.regions)
			? rec.regions.filter((r): r is string => isJsonString(r))
			: [];
		const cost = isJsonObject(rec.cost) ? rec.cost : {};
		parsed.push({
			...(isJsonString(rec.productId) && rec.productId.length > 0
				? { productId: rec.productId }
				: undefined),
			id:
				isJsonString(rec.id) && rec.id.length > 0
					? rec.id
					: `${body.providerId}:${rec.port}`,
			providerId: body.providerId,
			port: rec.port,
			features,
			regions,
			specificity: isJsonNumber(rec.specificity) ? rec.specificity : 10,
			priority: isJsonNumber(rec.priority) ? rec.priority : 0,
			cost: {
				sku: isJsonString(cost.sku)
					? cost.sku
					: `${body.providerId}-${rec.port}`,
				unit: isJsonString(cost.unit) ? cost.unit : "hour",
				marginalPrice: isJsonString(cost.marginalPrice)
					? cost.marginalPrice
					: "0",
				pricingStatus: parsePricingStatus(cost.pricingStatus),
			},
			satisfies: negotiateFromEntry(rec.port, features),
		});
	}
	return parsed;
}

export interface RegistryStreamFold {
	installed: Map<string, ResourceDefinition[]>;
	approved: Set<string>;
}

export function foldRegistryStream(
	events: Iterable<{ type: string; data?: unknown }>,
): RegistryStreamFold {
	const installed = new Map<string, ResourceDefinition[]>();
	const approved = new Set<string>();
	for (const event of events) {
		if (event.type === CLOUD_EVENTS.ProviderRegistered) {
			const defs = parseRegisteredDefinitions(event.data);
			const providerId = defs[0]?.providerId;
			if (providerId !== undefined) installed.set(providerId, defs);
		} else if (event.type === CLOUD_EVENTS.ProviderApproved) {
			const providerId = (event.data as { providerId?: unknown } | undefined)
				?.providerId;
			if (isJsonString(providerId) && providerId.length > 0)
				approved.add(providerId);
		}
	}
	return { installed, approved };
}

export interface EventBackedRegistryDeps {
	store: Pick<EventStore, "read">;
	streamId: string;
	base?: PlannerRegistry;
}

export function createEventBackedRegistry(
	deps: EventBackedRegistryDeps,
): PlannerRegistry & {
	refresh(): Promise<void>;
	held(): HeldProvider[];
} {
	let installedDefs: ResourceDefinition[] = [];
	let heldRows: HeldProvider[] = [];

	function combined(): ResourceDefinition[] {
		const baseDefs = deps.base?.definitions() ?? [];
		const baseProviders = new Set(baseDefs.map((d) => d.providerId));
		return [
			...baseDefs,
			...installedDefs.filter((d) => !baseProviders.has(d.providerId)),
		];
	}

	return {
		get catalogHash(): string {
			return catalogHashOf(combined());
		},
		definitions: () => combined().map((d) => ({ ...d })),
		providers: () => [...new Set(combined().map((d) => d.providerId))],
		async refresh(): Promise<void> {
			const events = await collectStream(deps.store, deps.streamId);
			const fold = foldRegistryStream(events);
			installedDefs = [...fold.installed.entries()]
				.filter(([providerId]) => fold.approved.has(providerId))
				.flatMap(([, defs]) => defs);
			heldRows = [...fold.installed.entries()]
				.filter(([providerId]) => !fold.approved.has(providerId))
				.map(([providerId, defs]) => ({
					providerId,
					ports: [...new Set(defs.map((d) => d.port))].sort(),
				}))
				.sort((a, b) => a.providerId.localeCompare(b.providerId));
		},
		held: () => heldRows.map((row) => ({ ...row, ports: [...row.ports] })),
	};
}

export interface RegistryCatalogRow {
	providerId: string;
	ports: string[];
	definitionCount: number;
	manifestIndexDigest: string;
}

export const registryCatalogProjection: Projection<RegistryCatalogRow> =
	defineProjection<RegistryCatalogRow>({
		name: "registry-catalog",
		key: (event) => (event.data as { providerId: string }).providerId,
		on: {
			[CLOUD_EVENTS.ProviderRegistered]: (_row, event) => {
				const data = event.data as {
					providerId: string;
					definitions: Array<{ port: string }>;
					manifestIndexDigest: string;
				};
				return {
					providerId: data.providerId,
					ports: data.definitions.map((d) => d.port).sort(),
					definitionCount: data.definitions.length,
					manifestIndexDigest: data.manifestIndexDigest,
				};
			},
		},
	});
