import {
	EQUIVALENCE_CLASSES,
	INITIAL_CAPABILITY_PORTS,
	type InitialCapabilityPort,
} from "./equivalence.js";
import {
	COST_FACTS,
	DEFAULT_REGIONS,
	KUBERNETES_PROVIDER_ID,
	publishCapabilityManifest,
} from "./manifest.js";
import { PROVIDER_TARGET } from "./options.js";
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
				pricingStatus: "unknown",
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

interface PortClassMap {
	readonly [port: string]: InitialCapabilityPort;
}

const PORT_TO_CLASS: PortClassMap = {
	compute: "web/service",
};

export interface KubernetesProviderOptions {
	/**
	 * Topology labels for the cluster's nodes. There is no way to discover
	 * these from the Kubernetes API without reading node labels an operator may
	 * not expose, so they are stated rather than guessed; the default is the
	 * one honest value.
	 */
	regions?: string[];
}

// The @hobo/provider-kubernetes factory (HOBO-87 authoring contract):
// capability declarations + the Kubernetes equivalence map as default Resource
// Definitions, realize() -> IacProgram for the primary Pulumi lane, a runtime
// client per port, and the published Capability Manifest with declared cost
// facts and the projected-ServiceAccount-token auth posture (HOBO-110 — this
// package stores no static keys).
export function createKubernetesProvider(
	options: KubernetesProviderOptions = {},
): CloudProvider {
	const regions = options.regions ?? DEFAULT_REGIONS;
	const published = publishCapabilityManifest({ regions });
	const capabilities = INITIAL_CAPABILITY_PORTS.map((classKey) =>
		makeCapability(classKey),
	);

	return {
		id: KUBERNETES_PROVIDER_ID,
		regions: [...regions],
		capabilities,
		realize(plan: ResourcePlan) {
			return realizeResourcePlan(plan);
		},
		capabilityManifest(): CapabilityManifest {
			return {
				providerId: KUBERNETES_PROVIDER_ID,
				published,
				capabilities: JSON.parse(
					published["/.well-known/capability-manifest/capabilities.json"],
				),
				auth: JSON.parse(
					published["/.well-known/capability-manifest/auth.json"],
				),
				cost: JSON.parse(
					published["/.well-known/capability-manifest/cost.json"],
				),
			};
		},
		client(port: PortKind, outputs: Outputs): ProviderClient {
			const classKey = PORT_TO_CLASS[port];
			if (!classKey) {
				throw new Error(
					`${PROVIDER_TARGET} provider has no client for port ${port}`,
				);
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

/**
 * The driver-program lane this package used to return from `realize()`.
 *
 * `realize()` now emits the canonical `hobo.iac-program/v1` document that
 * `@hobo/core`'s `CloudProvider` contract requires and every other provider
 * emits — the previous return value was a provider-shaped document that no
 * executor in the repo consumed. The driver program is kept here rather than
 * deleted because it names the *apply* path this package actually implements:
 * `provisionWorkload` in `./driver.ts`, talking to a real apiserver.
 */
export interface KubernetesDriverProgram {
	apiVersion: "hobo.driver-program/v1";
	driver: string;
	resources: Array<{ name: string; type: string; provider: string }>;
}

export function kubernetesDriverProgram(
	plan: ResourcePlan,
): KubernetesDriverProgram {
	const classKey = PORT_TO_CLASS[plan.port];
	if (!classKey) {
		throw new Error(`${PROVIDER_TARGET} cannot realize port ${plan.port}`);
	}
	const mapping = EQUIVALENCE_CLASSES[classKey];
	return {
		apiVersion: "hobo.driver-program/v1",
		driver: `${PROVIDER_TARGET}-deploy`,
		resources: [
			{
				name: plan.name,
				type: mapping.resourceClass,
				provider: PROVIDER_TARGET,
			},
		],
	};
}
