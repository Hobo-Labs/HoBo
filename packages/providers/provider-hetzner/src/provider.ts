import {
	EQUIVALENCE_CLASSES,
	INITIAL_CAPABILITY_PORTS,
	type InitialCapabilityPort,
} from "./equivalence.js";
import { parseJsonObject } from "./json.js";
import {
	COST_FACTS,
	DEFAULT_REGIONS,
	HETZNER_PROVIDER_ID,
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
				currency: "USD",
				pricingStatus: "estimate",
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

function classForPort(port: string): InitialCapabilityPort | undefined {
	switch (port) {
		case "compute":
			return "web/service";
		case "objectStore":
			return "objectStore";
		default:
			return undefined;
	}
}

export interface HetznerProviderOptions {
	regions?: string[];
}

// The @hobo/provider-hetzner factory (HOBO-87 authoring contract): capability
// declarations + the Hetzner equivalence map as default Resource Definitions,
// realize() -> IacProgram for the primary Pulumi lane, a runtime client per
// port, and the published Capability Manifest with declared cost facts and the
// broker-custody credential-locator auth posture (HOBO-110 — this package
// stores no static keys).
export function createHetznerProvider(
	options: HetznerProviderOptions = {},
): CloudProvider {
	const regions = options.regions ?? DEFAULT_REGIONS;
	const published = publishCapabilityManifest({ regions });
	const capabilities = INITIAL_CAPABILITY_PORTS.map((classKey) =>
		makeCapability(classKey),
	);

	return {
		id: HETZNER_PROVIDER_ID,
		regions: [...regions],
		capabilities,
		realize(plan: ResourcePlan) {
			return realizeResourcePlan(plan);
		},
		capabilityManifest(): CapabilityManifest {
			return {
				providerId: HETZNER_PROVIDER_ID,
				published,
				capabilities: parseJsonObject(
					published["/.well-known/capability-manifest/capabilities.json"] ??
						"{}",
				),
				auth: parseJsonObject(
					published["/.well-known/capability-manifest/auth.json"] ?? "{}",
				),
				cost: parseJsonObject(
					published["/.well-known/capability-manifest/cost.json"] ?? "{}",
				),
			};
		},
		client(port: PortKind, outputs: Outputs): ProviderClient {
			const classKey = classForPort(port);
			if (!classKey) {
				throw new Error(`hetzner provider has no client for port ${port}`);
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
