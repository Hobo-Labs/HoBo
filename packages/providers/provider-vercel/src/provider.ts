import { VERCEL_STATIC_DEPLOY_PRODUCT_ID } from "./deployment-resolver.js";
import {
	EQUIVALENCE_CLASSES,
	INITIAL_CAPABILITY_PORTS,
	type InitialCapabilityPort,
} from "./equivalence.js";
import { PROVIDER_TARGET } from "./options.js";
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
	return {
		port,
		satisfies(req: PortRequest): Match {
			if (req.port !== port) return { kind: "none" };
			const missing = (req.features ?? []).filter((f) => !features.includes(f));
			return missing.length === 0
				? { kind: "full" }
				: { kind: "partial", missing };
		},
		estimateCost(_req: PortRequest): CostSignal {
			return {
				currency: "USD",
				sku: `${PROVIDER_TARGET}:${mapping.resourceClass}`,
				unit: "request",
				marginalPrice: "0",
				pricingStatus: "unknown",
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
		case "database":
			return "database/postgres";
		case "kv":
			return "kv";
		default:
			return undefined;
	}
}

export function createVercelProvider(): CloudProvider {
	const capabilities = INITIAL_CAPABILITY_PORTS.map((key) =>
		makeCapability(key),
	);
	return {
		id: `@hobo/provider-${PROVIDER_TARGET}`,
		regions: ["global"],
		capabilities,
		realize(plan: ResourcePlan) {
			const classKey = classForPort(plan.port);
			if (!classKey) {
				throw new Error(`${PROVIDER_TARGET} cannot realize port ${plan.port}`);
			}
			const mapping = EQUIVALENCE_CLASSES[classKey];
			return {
				driver: {
					apiVersion: "hobo.driver-program/v1",
					driver: `${PROVIDER_TARGET}-deploy`,
					resources: [
						{
							name: plan.name,
							type: mapping.resourceClass,
							provider: PROVIDER_TARGET,
						},
					],
				},
			};
		},
		capabilityManifest(): CapabilityManifest {
			return {
				providerId: `@hobo/provider-${PROVIDER_TARGET}`,
				published: {},
				capabilities: {
					capabilities: capabilities.map((c) => ({
						port: c.port,
						...(c.port === "compute"
							? {
									productId: VERCEL_STATIC_DEPLOY_PRODUCT_ID,
									profiles: ["web.static/v1", "web.hosted/v1"],
									features: ["http", "static", "managed"],
									resourceKind: "immutable-deployment",
								}
							: undefined),
					})),
				},
				auth: { exchange: "hobo:brokered-deploy-token", staticSecrets: false },
				cost: { pricingStatus: "unknown", facts: [] },
			};
		},
		client(port: PortKind, outputs: Outputs): ProviderClient {
			const classKey = classForPort(port);
			if (!classKey) throw new Error(`no client for port ${port}`);
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
