import {
	EQUIVALENCE_CLASSES,
	type InitialCapabilityPort,
} from "./equivalence.js";
import {
	CLOUDFLARE_PROVIDER_TARGET,
	type HelloBindlePlan,
} from "./hello-bindle.js";
import {
	CLOUDFLARE_IAC_PROVIDER,
	IAC_PROGRAM_API_VERSION,
	IAC_PROGRAM_KIND,
	IAC_PROVIDER,
	type IacProgram,
	type IacResource,
} from "./iac-program.js";
import { isJsonString, type JsonObject } from "./json.js";
import { CLOUDFLARE_PROVIDER_ID } from "./manifest.js";
import type { ResourcePlan } from "./types.js";

export interface BuildSpec {
	kind: "hobo.build-spec/v1";
	artifacts: Array<{ id: string; source: string; target: string }>;
}

const PORT_TO_CLASS = {
	compute: "web/service",
	kv: "kv",
	objectStore: "objectStore",
	queue: "queue",
	schedule: "schedule",
} as const satisfies Record<string, InitialCapabilityPort>;

export type RealizablePort = keyof typeof PORT_TO_CLASS;

function outputsForClass(resourceClass: string): readonly string[] {
	switch (resourceClass) {
		case "cloudflare:workers-script":
			return ["url", "scriptName", "binding"];
		case "cloudflare:kv-namespace":
			return ["namespaceId", "binding"];
		case "cloudflare:r2-bucket":
			return ["bucketName", "endpoint", "binding"];
		case "cloudflare:queue":
			return ["queueName", "binding"];
		case "cloudflare:cron-trigger":
			return ["cron", "binding"];
		default:
			return ["binding"];
	}
}

function primaryOutput(resourceClass: string): string {
	switch (resourceClass) {
		case "cloudflare:workers-script":
			return "url";
		case "cloudflare:kv-namespace":
			return "namespaceId";
		case "cloudflare:r2-bucket":
			return "bucketName";
		case "cloudflare:queue":
			return "queueName";
		case "cloudflare:cron-trigger":
			return "cron";
		default:
			return "binding";
	}
}

export function isRealizablePort(port: string): port is RealizablePort {
	return port in PORT_TO_CLASS;
}

export function resolveEquivalence(port: string) {
	if (!isRealizablePort(port)) {
		throw new Error(`cloudflare provider cannot realize port ${port}`);
	}
	return EQUIVALENCE_CLASSES[PORT_TO_CLASS[port]];
}

export function mergeCloudflareOptions(
	options: ResourcePlan["options"] = [],
): JsonObject {
	const merged = {};
	for (const block of options) {
		if (block.providerId !== CLOUDFLARE_PROVIDER_TARGET) {
			continue;
		}
		Object.assign(merged, block.options);
	}
	return merged;
}

function buildResource(
	plan: ResourcePlan,
	withBindRefs: boolean,
	classOf: ReadonlyMap<string, string> = new Map(),
): IacResource {
	const mapping = resolveEquivalence(plan.port);
	const resourceClass = mapping.resourceClass;
	const bindings = (plan.deps ?? []).map((dep) => {
		const resourceType = classOf.get(dep);
		const typed = resourceType === undefined ? undefined : { resourceType };
		return withBindRefs
			? {
					resource: dep,
					ref: `\${resources.${dep}.outputs.binding}`,
					...typed,
				}
			: { providerResourceId: dep, ...typed };
	});

	const inputs = {
		port: plan.port,
		providerService: mapping.providerService,
		features: [...mapping.features],
		options: {
			...mergeCloudflareOptions(plan.options),
			...(plan.port === "schedule" &&
			isJsonString(plan.realizationParameters?.cron)
				? { cron: plan.realizationParameters.cron }
				: undefined),
		},
		bindings,
		...(plan.region === undefined ? undefined : { region: plan.region }),
	};

	return {
		name: plan.name,
		type: resourceClass,
		provider: CLOUDFLARE_IAC_PROVIDER,
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
		stack: `${CLOUDFLARE_IAC_PROVIDER}/${deploymentId}`,
		resources: [resource],
		stackOutputs: { [`${plan.name}.endpoint`]: primaryRef(resource) },
	};
	const build = buildSpecFor(plan);
	return build ? { iac, build } : { iac };
}

const CLOUDFLARE_PLAN_PROVIDERS: ReadonlySet<string> = new Set([
	CLOUDFLARE_PROVIDER_TARGET,
	CLOUDFLARE_PROVIDER_ID,
]);

export function realizeResourcePlans(
	plans: ResourcePlan[],
	options: { deploymentId?: string } = {},
): { iac: IacProgram; build?: BuildSpec } {
	if (plans.length === 0) {
		throw new Error("cannot realize an empty deployment plan");
	}
	const classOf = new Map(
		plans.flatMap((plan) =>
			CLOUDFLARE_PLAN_PROVIDERS.has(plan.provider) &&
			isRealizablePort(plan.port)
				? [[plan.name, resolveEquivalence(plan.port).resourceClass] as const]
				: [],
		),
	);
	const resources = plans.map((plan) => buildResource(plan, true, classOf));
	const deploymentId = options.deploymentId ?? "hello-bindle-cloudflare";
	const first = resources[0];
	if (first === undefined) {
		throw new Error("cannot realize an empty deployment plan");
	}
	const iac: IacProgram = {
		apiVersion: IAC_PROGRAM_API_VERSION,
		kind: IAC_PROGRAM_KIND,
		provider: IAC_PROVIDER,
		deploymentId,
		stack: `${CLOUDFLARE_IAC_PROVIDER}/${deploymentId}`,
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

export function toResourcePlans(plan: HelloBindlePlan): ResourcePlan[] {
	return plan.resources.map((resource) => ({
		name: resource.id,
		port: resource.type,
		provider: CLOUDFLARE_PROVIDER_TARGET,
		options: resource.options,
		region: resource.colo,
		deploymentId: plan.id,
		...(resource.binds
			? { deps: resource.binds.map((bind) => bind.providerResourceId) }
			: undefined),
		...(resource.build ? { build: resource.build } : undefined),
	}));
}

export function realizeHelloBindle(plan: HelloBindlePlan): {
	iac: IacProgram;
	build?: BuildSpec;
} {
	return realizeResourcePlans(toResourcePlans(plan), { deploymentId: plan.id });
}
