import {
	EQUIVALENCE_CLASSES,
	INITIAL_CAPABILITY_PORTS,
	type InitialCapabilityPort,
} from "./equivalence.js";
import { parseJsonObject } from "./json.js";
import {
	COST_FACTS,
	DEFAULT_REGIONS,
	LAKEBED_PROVIDER_ID,
	publishCapabilityManifest,
} from "./manifest.js";
import { realizeResourcePlan } from "./realize.js";
import type {
	Capability,
	CapabilityManifest,
	CloudProvider,
	CostSignal,
	Match,
	Outputs,
	PortKind,
	PortRequest,
	ProviderClient,
	ResourcePlan,
} from "./types.js";

function makeCapability(classKey: InitialCapabilityPort): Capability {
	const mapping = EQUIVALENCE_CLASSES[classKey];
	const port = mapping.port;
	const features: readonly string[] = mapping.features;
	const fact = COST_FACTS[classKey];

	return {
		port,
		satisfies(req: PortRequest): Match {
			if (req.port !== port) {
				return { kind: "none" };
			}
			const missing = (req.features ?? []).filter(
				(feature) => !features.includes(feature),
			);
			return missing.length === 0
				? { kind: "full" }
				: { kind: "partial", missing };
		},
		estimateCost(_req: PortRequest): CostSignal {
			return {
				pricingStatus: "estimate",
				currency: "USD",
				sku: fact.sku,
				unit: fact.unit,
				marginalPrice: fact.marginalPrice,
				freeTier: {
					unit: fact.unit,
					included: fact.included,
					reset: "monthly",
				},
			};
		},
	};
}

const PORT_TO_CLASS = {
	compute: "web/service",
	kv: "kv",
	objectStore: "objectStore",
	database: "database/reactive",
} satisfies Record<string, InitialCapabilityPort>;

function classForPort(port: string): InitialCapabilityPort | undefined {
	switch (port) {
		case "compute":
		case "kv":
		case "objectStore":
		case "database":
			return PORT_TO_CLASS[port];
		default:
			return undefined;
	}
}

export interface LakebedProviderOptions {
	regions?: string[];
}

// The @hobo/provider-lakebed factory (HOBO-87 authoring contract, ADR-0127):
// capability declarations honestly scoped to the closed Capsule PaaS as
// default Resource Definitions, realize() -> a lakebed-deploy DRIVER program
// (not IaC), a runtime client per port, and the published Capability Manifest
// with declared cost facts and the brokered-deploy-token posture (HOBO-110 —
// no static vendor tokens).
export function createLakebedProvider(
	options: LakebedProviderOptions = {},
): CloudProvider {
	const regions = options.regions ?? DEFAULT_REGIONS;
	const published = publishCapabilityManifest({ regions });
	const capabilities = INITIAL_CAPABILITY_PORTS.map((classKey) =>
		makeCapability(classKey),
	);

	return {
		id: LAKEBED_PROVIDER_ID,
		regions: [...regions],
		capabilities,
		realize(plan: ResourcePlan) {
			return realizeResourcePlan(plan);
		},
		capabilityManifest(): CapabilityManifest {
			return {
				providerId: LAKEBED_PROVIDER_ID,
				published,
				capabilities: parseJsonObject(
					published["/.well-known/capability-manifest/capabilities.json"],
				),
				auth: parseJsonObject(
					published["/.well-known/capability-manifest/auth.json"],
				),
				cost: parseJsonObject(
					published["/.well-known/capability-manifest/cost.json"],
				),
			};
		},
		client(port: PortKind, outputs: Outputs): ProviderClient {
			const classKey = classForPort(port);
			if (classKey === undefined) {
				throw new Error(`lakebed provider has no client for port ${port}`);
			}
			const mapping = EQUIVALENCE_CLASSES[classKey];
			return {
				port,
				resourceClass: mapping.resourceClass,
				providerService: mapping.providerService,
				bindings: outputs,
			};
		},
	};
}
