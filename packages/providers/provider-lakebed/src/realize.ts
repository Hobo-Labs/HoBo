import type { RoutingPlan } from "@hobo/core";

import {
	assertDriverProgram,
	DRIVER_PROGRAM_API_VERSION,
	DRIVER_PROGRAM_KIND,
	type DriverProgram,
	type DriverResource,
	LAKEBED_DRIVER,
} from "./driver-program.js";
import {
	EQUIVALENCE_CLASSES,
	type InitialCapabilityPort,
} from "./equivalence.js";
import type { JsonObject, JsonValue } from "./json.js";
import { LAKEBED_PROVIDER_TARGET } from "./options.js";
import type { ResourcePlan } from "./types.js";

const PORT_TO_CLASS = {
	compute: "web/service",
	kv: "kv",
	objectStore: "objectStore",
	database: "database/reactive",
} as const satisfies Record<string, InitialCapabilityPort>;

export type RealizablePort = keyof typeof PORT_TO_CLASS;

const OUTPUTS_BY_CLASS = {
	"lakebed:capsule": ["url", "capsuleId", "binding"],
	"lakebed:capsule-kv": ["namespace", "binding"],
	"lakebed:file-store": ["storeName", "binding"],
	"lakebed:reactive-db": ["endpoint", "binding"],
	"lakebed:traffic-route": ["routeId", "binding"],
} satisfies Record<string, string[]>;

const PRIMARY_OUTPUT = {
	"lakebed:capsule": "url",
	"lakebed:capsule-kv": "namespace",
	"lakebed:file-store": "storeName",
	"lakebed:reactive-db": "endpoint",
	"lakebed:traffic-route": "routeId",
} satisfies Record<string, string>;

export function isRealizablePort(port: string): port is RealizablePort {
	return port in PORT_TO_CLASS;
}

export function resolveEquivalence(port: string) {
	if (!isRealizablePort(port)) {
		throw new Error(`lakebed provider cannot realize port ${port}`);
	}
	return EQUIVALENCE_CLASSES[PORT_TO_CLASS[port]];
}

export function mergeLakebedOptions(
	options: ResourcePlan["options"] = [],
): JsonObject {
	const merged: { [key: string]: JsonValue } = {};
	for (const block of options) {
		if (block.providerId !== LAKEBED_PROVIDER_TARGET) {
			continue;
		}
		const inner = block.options;
		if (Object.prototype.toString.call(inner) !== "[object Object]") {
			continue;
		}
		Object.assign(merged, inner as JsonObject);
	}
	return merged;
}

function buildResource(
	plan: ResourcePlan,
	withBindRefs: boolean,
): DriverResource {
	const mapping = resolveEquivalence(plan.port);
	const bindings = (plan.deps ?? []).map((dep) =>
		withBindRefs
			? { resource: dep, ref: `\${resources.${dep}.outputs.binding}` }
			: { providerResourceId: dep },
	);

	return {
		name: plan.name,
		type: mapping.resourceClass,
		provider: LAKEBED_PROVIDER_TARGET,
		inputs: {
			port: plan.port,
			providerService: mapping.providerService,
			features: [...mapping.features],
			options: mergeLakebedOptions(plan.options),
			bindings,
		},
		outputs: outputsForClass(mapping.resourceClass),
	};
}

function outputsForClass(resourceClass: string): string[] {
	switch (resourceClass) {
		case "lakebed:capsule":
		case "lakebed:capsule-kv":
		case "lakebed:file-store":
		case "lakebed:reactive-db":
		case "lakebed:traffic-route":
			return OUTPUTS_BY_CLASS[resourceClass];
		default:
			return ["binding"];
	}
}

function primaryOutputName(type: string): string {
	switch (type) {
		case "lakebed:capsule":
		case "lakebed:capsule-kv":
		case "lakebed:file-store":
		case "lakebed:reactive-db":
		case "lakebed:traffic-route":
			return PRIMARY_OUTPUT[type];
		default:
			return "binding";
	}
}

function primaryRef(resource: DriverResource): string {
	const output = primaryOutputName(resource.type);
	return `\${resources.${resource.name}.outputs.${output}}`;
}

export function realizeResourcePlan(plan: ResourcePlan) {
	const resource = buildResource(plan, false);
	const deploymentId = plan.deploymentId ?? plan.name;
	return {
		driver: assertDriverProgram({
			apiVersion: DRIVER_PROGRAM_API_VERSION,
			kind: DRIVER_PROGRAM_KIND,
			driver: LAKEBED_DRIVER,
			deploymentId,
			capsule: `capsule/${deploymentId}`,
			resources: [resource],
			outputs: { [`${plan.name}.endpoint`]: primaryRef(resource) },
		}),
	};
}

export function realizeResourcePlans(
	plans: ResourcePlan[],
	options: { deploymentId?: string } = {},
) {
	if (plans.length === 0) {
		throw new Error("cannot realize an empty deployment plan");
	}
	const resources = plans.map((plan) => buildResource(plan, true));
	const deploymentId = options.deploymentId ?? "hello-bindle-lakebed";
	const first = resources[0];
	if (first === undefined) {
		throw new Error("cannot realize an empty deployment plan");
	}
	return {
		driver: assertDriverProgram({
			apiVersion: DRIVER_PROGRAM_API_VERSION,
			kind: DRIVER_PROGRAM_KIND,
			driver: LAKEBED_DRIVER,
			deploymentId,
			capsule: `capsule/${deploymentId}`,
			resources,
			outputs: { endpoint: primaryRef(first) },
		}),
	};
}

export function realizeTrafficRoutingPlan(
	plan: RoutingPlan,
	options: { deploymentId?: string; capsule?: string } = {},
) {
	const deploymentId =
		options.deploymentId?.trim() || sanitizeDriverId(plan.planId) || "traffic";
	const capsule =
		options.capsule?.trim() ||
		`capsule/${sanitizeDriverId(plan.intent.service) || "service"}`;
	const resourceName = `route-${sanitizeDriverId(plan.planId)}`;
	const resource: DriverResource = {
		name: resourceName,
		type: "lakebed:traffic-route",
		provider: LAKEBED_PROVIDER_TARGET,
		inputs: {
			planId: plan.planId,
			service: plan.intent.service,
			tenantId: plan.intent.tenantId,
			backends: plan.backends.map((backend) => ({
				id: backend.id,
				service: backend.service,
				...(backend.endpoint === undefined
					? undefined
					: { endpoint: backend.endpoint }),
				...(backend.weight === undefined
					? undefined
					: { weight: backend.weight }),
				...(backend.locationHints === undefined
					? undefined
					: { locationHints: [...backend.locationHints] }),
			})),
			rules: plan.intent.rules.map((rule) => ({
				weightStrategy: rule.weightStrategy,
				...(rule.match
					? {
							match: {
								...(rule.match.pathPrefix
									? { pathPrefix: rule.match.pathPrefix }
									: undefined),
								...(rule.match.headers
									? { headers: { ...rule.match.headers } }
									: undefined),
							},
						}
					: undefined),
				backends: rule.backends.map((backend) => backend.id),
			})),
		},
		outputs: OUTPUTS_BY_CLASS["lakebed:traffic-route"] ?? [
			"routeId",
			"binding",
		],
	};
	const driver: DriverProgram = {
		apiVersion: DRIVER_PROGRAM_API_VERSION,
		kind: DRIVER_PROGRAM_KIND,
		driver: LAKEBED_DRIVER,
		deploymentId,
		capsule,
		resources: [resource],
		outputs: {
			routeId: primaryRef(resource),
			binding: `\${resources.${resourceName}.outputs.binding}`,
		},
	};
	return { driver: assertDriverProgram(driver) };
}

function sanitizeDriverId(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
}
