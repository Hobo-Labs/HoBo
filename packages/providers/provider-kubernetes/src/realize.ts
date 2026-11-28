import {
	EQUIVALENCE_CLASSES,
	type InitialCapabilityPort,
} from "./equivalence.js";
import {
	IAC_PROGRAM_API_VERSION,
	IAC_PROGRAM_KIND,
	IAC_PROVIDER,
	type IacProgram,
	type IacResource,
	KUBERNETES_IAC_PROVIDER,
} from "./iac-program.js";
import type { JsonObject } from "./json.js";
import { PROVIDER_TARGET, type TypedOptionBlock } from "./options.js";
import type { ResourcePlan } from "./types.js";

export interface BuildSpec {
	kind: "hobo.build-spec/v1";
	artifacts: Array<{ id: string; source: string; target: string }>;
}

const PORT_TO_CLASS = {
	compute: "web/service",
} as const satisfies Record<string, InitialCapabilityPort>;

export type RealizablePort = keyof typeof PORT_TO_CLASS;

interface OutputsByClass {
	readonly [resourceClass: string]: readonly string[];
}

const OUTPUTS_BY_CLASS: OutputsByClass = {
	"kubernetes:deployment": ["url", "namespace", "binding"],
};

interface PrimaryOutputByClass {
	readonly [resourceClass: string]: string;
}

const PRIMARY_OUTPUT: PrimaryOutputByClass = {
	"kubernetes:deployment": "url",
};

export function isRealizablePort(port: string): port is RealizablePort {
	return port in PORT_TO_CLASS;
}

export function resolveEquivalence(port: string) {
	if (!isRealizablePort(port)) {
		throw new Error(`kubernetes provider cannot realize port ${port}`);
	}
	return EQUIVALENCE_CLASSES[PORT_TO_CLASS[port]];
}

export function mergeKubernetesOptions(
	options: ResourcePlan["options"] = [],
): JsonObject {
	const merged: JsonObject = {};
	// SAFETY: assertion to `tions as TypedOptionBlock[]) ` is required at this boundary.
	for (const block of options as TypedOptionBlock[]) {
		if (block.providerId !== PROVIDER_TARGET) {
			continue;
		}
		Object.assign(merged, block.options);
	}
	return merged;
}

function buildResource(plan: ResourcePlan, withBindRefs: boolean): IacResource {
	const mapping = resolveEquivalence(plan.port);
	const resourceClass = mapping.resourceClass;
	const bindings = (plan.deps ?? []).map((dep) =>
		withBindRefs
			? { resource: dep, ref: `\${resources.${dep}.outputs.binding}` }
			: { providerResourceId: dep },
	);

	const inputs: JsonObject = {
		port: plan.port,
		providerService: mapping.providerService,
		features: [...mapping.features],
		options: mergeKubernetesOptions(plan.options),
		bindings,
		...(plan.region === undefined ? undefined : { region: plan.region }),
	};

	return {
		name: plan.name,
		type: resourceClass,
		provider: KUBERNETES_IAC_PROVIDER,
		inputs,
		outputs: [...(OUTPUTS_BY_CLASS[resourceClass] ?? ["binding"])],
	};
}

function buildSpecFor(plan: ResourcePlan): BuildSpec | undefined {
	if (!plan.build) {
		return undefined;
	}
	return {
		kind: "hobo.build-spec/v1",
		artifacts: [
			{
				id: plan.build.artifactId,
				source: plan.build.source,
				target: plan.build.target,
			},
		],
	};
}

function primaryRef(resource: IacResource): string {
	const output = PRIMARY_OUTPUT[resource.type] ?? "binding";
	return `\${resources.${resource.name}.outputs.${output}}`;
}

export function realizeResourcePlan(plan: ResourcePlan): {
	iac: IacProgram;
	build?: BuildSpec;
} {
	const resource = buildResource(plan, false);
	const deploymentId = plan.deploymentId ?? plan.name;
	const iac: IacProgram = {
		apiVersion: IAC_PROGRAM_API_VERSION,
		kind: IAC_PROGRAM_KIND,
		provider: IAC_PROVIDER,
		deploymentId,
		stack: `${KUBERNETES_IAC_PROVIDER}/${deploymentId}`,
		resources: [resource],
		stackOutputs: { [`${plan.name}.endpoint`]: primaryRef(resource) },
	};
	const build = buildSpecFor(plan);
	return build ? { iac, build } : { iac };
}

export function realizeResourcePlans(
	plans: ResourcePlan[],
	options: { deploymentId?: string } = {},
): { iac: IacProgram; build?: BuildSpec } {
	if (plans.length === 0) {
		throw new Error("cannot realize an empty deployment plan");
	}
	const resources = plans.map((plan) => buildResource(plan, true));
	const deploymentId = options.deploymentId ?? "hello-bindle-kubernetes";
	// SAFETY: assertion to `sources[0] as IacResource; ` is required at this boundary.
	const first = resources[0] as IacResource;
	const iac: IacProgram = {
		apiVersion: IAC_PROGRAM_API_VERSION,
		kind: IAC_PROGRAM_KIND,
		provider: IAC_PROVIDER,
		deploymentId,
		stack: `${KUBERNETES_IAC_PROVIDER}/${deploymentId}`,
		resources,
		stackOutputs: { endpoint: primaryRef(first) },
	};
	const artifacts = plans.flatMap(
		(plan) => buildSpecFor(plan)?.artifacts ?? [],
	);
	return artifacts.length > 0
		? { iac, build: { kind: "hobo.build-spec/v1", artifacts } }
		: { iac };
}
