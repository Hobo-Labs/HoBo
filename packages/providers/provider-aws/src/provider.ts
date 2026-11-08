import {
	EQUIVALENCE_CLASSES,
	INITIAL_CAPABILITY_PORTS,
	type InitialCapabilityPort,
} from "./equivalence.js";
import { parseJsonObject } from "./json.js";
import {
	AWS_PROVIDER_ID,
	COST_FACTS,
	DEFAULT_REGIONS,
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
				sku: fact.sku,
				unit: fact.unit,
				marginalPrice: fact.marginalPrice,
				pricingStatus: /^0(?:\.0+)?$/u.test(fact.marginalPrice)
					? "unknown"
					: "estimate",
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
		case "kv":
			return "kv";
		case "objectStore":
			return "objectStore";
		case "database":
			return "database/postgres";
		case "queue":
			return "queue";
		case "cache":
			return "cache";
		default:
			return undefined;
	}
}

export interface AwsProviderOptions {
	regions?: string[];
}

// The @hobo/provider-aws factory (HOBO-87 authoring contract): capability
// declarations + the AWS equivalence map as default Resource Definitions,
// realize() -> IacProgram for the primary Pulumi lane, a runtime client per
// port, and the published Capability Manifest with declared cost facts and the
// keyless AssumeRoleWithWebIdentity auth posture (HOBO-110 — no static keys).
export function createAwsProvider(
	options: AwsProviderOptions = {},
): CloudProvider {
	const regions = options.regions ?? DEFAULT_REGIONS;
	const published = publishCapabilityManifest({ regions });
	const capabilities = INITIAL_CAPABILITY_PORTS.map((classKey) =>
		makeCapability(classKey),
	);

	return {
		id: AWS_PROVIDER_ID,
		regions: [...regions],
		capabilities,
		realize(plan: ResourcePlan) {
			return realizeResourcePlan(plan);
		},
		capabilityManifest(): CapabilityManifest {
			return {
				providerId: AWS_PROVIDER_ID,
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
				throw new Error(`aws provider has no client for port ${port}`);
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
