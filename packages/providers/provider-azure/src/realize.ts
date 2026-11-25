import {
	EQUIVALENCE_CLASSES,
	type InitialCapabilityPort,
} from "./equivalence.js";
import {
	AZURE_IAC_PROVIDER,
	IAC_PROGRAM_API_VERSION,
	IAC_PROGRAM_KIND,
	IAC_PROVIDER,
	type IacProgram,
	type IacResource,
} from "./iac-program.js";
import type { JsonObject } from "./json.js";
import { AZURE_PROVIDER_TARGET } from "./options.js";
import type { ResourcePlan } from "./types.js";

export interface BuildSpec {
	kind: "hobo.build-spec/v1";
	artifacts: Array<{ id: string; source: string; target: string }>;
}

const PORT_TO_CLASS = {
	compute: "web/service",
	kv: "kv",
	objectStore: "objectStore",
	database: "database/postgres",
	queue: "queue",
	cache: "cache",
} as const satisfies Record<string, InitialCapabilityPort>;

export type RealizablePort = keyof typeof PORT_TO_CLASS;

function outputsForClass(resourceClass: string): readonly string[] {
	switch (resourceClass) {
		case "azure:container-app":
			return ["url", "fqdn", "binding"];
		case "azure:cosmos-table":
			return ["tableName", "endpoint", "binding"];
		case "azure:storage-blob-container":
			return ["containerName", "endpoint", "binding"];
		case "azure:postgres-flexible-server":
			return ["endpoint", "connectionString", "binding"];
		case "azure:servicebus-queue":
			return ["queueName", "namespaceEndpoint", "binding"];
		case "azure:cache-redis":
			return ["endpoint", "port", "binding"];
		default:
			return ["binding"];
	}
}

function primaryOutput(resourceClass: string): string {
	switch (resourceClass) {
		case "azure:container-app":
			return "url";
		case "azure:cosmos-table":
			return "tableName";
		case "azure:storage-blob-container":
			return "containerName";
		case "azure:postgres-flexible-server":
			return "endpoint";
		case "azure:servicebus-queue":
			return "queueName";
		case "azure:cache-redis":
			return "endpoint";
		default:
			return "binding";
	}
}

export function isRealizablePort(port: string): port is RealizablePort {
	return port in PORT_TO_CLASS;
}

export function resolveEquivalence(port: string) {
	if (!isRealizablePort(port)) {
		throw new Error(`azure provider cannot realize port ${port}`);
	}
	return EQUIVALENCE_CLASSES[PORT_TO_CLASS[port]];
}

export function mergeAzureOptions(
	options: ResourcePlan["options"] = [],
): JsonObject {
	const merged = {};
	for (const block of options) {
		if (block.providerId !== AZURE_PROVIDER_TARGET) {
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

	const inputs = {
		port: plan.port,
		providerService: mapping.providerService,
		features: [...mapping.features],
		options: mergeAzureOptions(plan.options),
		bindings,
		...(plan.region === undefined ? undefined : { region: plan.region }),
	};

	return {
		name: plan.name,
		type: resourceClass,
		provider: AZURE_IAC_PROVIDER,
		inputs,
		outputs: [...outputsForClass(resourceClass)],
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
	const output = primaryOutput(resource.type);
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
		stack: `${AZURE_IAC_PROVIDER}/${deploymentId}`,
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
	const deploymentId = options.deploymentId ?? "hello-bindle-azure";
	const first = resources[0];
	if (first === undefined) {
		throw new Error("cannot realize an empty deployment plan");
	}
	const iac: IacProgram = {
		apiVersion: IAC_PROGRAM_API_VERSION,
		kind: IAC_PROGRAM_KIND,
		provider: IAC_PROVIDER,
		deploymentId,
		stack: `${AZURE_IAC_PROVIDER}/${deploymentId}`,
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
