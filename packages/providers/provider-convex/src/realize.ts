// Realization: a provider-neutral ResourcePlan becomes a convex-deploy
// DRIVER program (not IaC). Every program provisions into one Convex
// deployment resource and wires port-specific resources beside it; outputs
// use the platform's `${resources.<name>.outputs.<key>}` placeholder syntax
// so dependent resources resolve through the normal manifest path.
import {
	assertDriverProgram,
	CONVEX_DRIVER,
	DRIVER_PROGRAM_API_VERSION,
	DRIVER_PROGRAM_KIND,
	type DriverProgram,
	type DriverResource,
} from "./driver-program.js";
import { EQUIVALENCE_CLASSES } from "./equivalence.js";
import type { JsonValue } from "./json.js";
import { CONVEX_PROVIDER_ID } from "./manifest.js";
import type { ResourcePlan } from "./types.js";

const PORT_TO_CLASS = {
	compute: "web/service",
	database: "database/reactive",
	objectStore: "objectStore",
} satisfies Record<string, keyof typeof EQUIVALENCE_CLASSES>;

function classForPort(
	port: string,
): keyof typeof EQUIVALENCE_CLASSES | undefined {
	switch (port) {
		case "compute":
		case "database":
		case "objectStore":
			return PORT_TO_CLASS[port];
		default:
			return undefined;
	}
}

export function realizeResourcePlan(plan: ResourcePlan) {
	const classKey = classForPort(plan.port);
	if (!classKey) {
		throw new Error(
			`convex provider cannot realize port ${plan.port}; supported: ${Object.keys(PORT_TO_CLASS).join(", ")}`,
		);
	}
	const mapping = EQUIVALENCE_CLASSES[classKey];
	const deploymentId = plan.deploymentId ?? `deploy-${plan.name}`;
	const deploymentSlug = `${plan.name}-${plan.region ?? "us"}`;

	const deployment: DriverResource = {
		name: "deployment",
		type: "convex:deployment",
		provider: CONVEX_PROVIDER_ID,
		inputs: {
			slug: deploymentSlug,
			region: plan.region ?? "us",
		},
		outputs: ["url", "deploymentName"],
	};

	const resource: DriverResource = {
		name: plan.name,
		type: mapping.resourceClass,
		provider: CONVEX_PROVIDER_ID,
		inputs: {
			deployment: "${resources.deployment.outputs.deploymentName}",
			...(plan.options?.length
				? {
						// SAFETY: option blocks are JSON-serializable at this driver boundary.
						options: JSON.parse(JSON.stringify(plan.options)) as JsonValue,
					}
				: undefined),
		},
		outputs:
			classKey === "database/reactive"
				? ["tableNamespace", "connectionRef"]
				: classKey === "objectStore"
					? ["storageNamespace", "connectionRef"]
					: ["httpUrl", "connectionRef"],
	};

	const program = {
		apiVersion: DRIVER_PROGRAM_API_VERSION,
		kind: DRIVER_PROGRAM_KIND,
		driver: CONVEX_DRIVER,
		deploymentId,
		deployment: deploymentSlug,
		resources: [deployment, resource],
		outputs: {
			deploymentUrl: "${resources.deployment.outputs.url}",
			connectionRef: `\${resources.${plan.name}.outputs.connectionRef}`,
		},
	} satisfies DriverProgram;
	return { driver: assertDriverProgram(program) };
}
