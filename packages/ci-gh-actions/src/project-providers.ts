import { z } from "zod";

// public-contract: published `$id` editors and the project schema resolve.
export const CI_PROJECT_PROVIDERS_SCHEMA_ID =
	"https://raw.githubusercontent.com/Hobo-Labs/HoBo/main/packages/ci-gh-actions/schema/ci-project-providers.schema.json";
/** Relative to `ci-project.schema.json`, so editors resolve the sibling file. */
// public-contract: the `$ref` shipped inside `ci-project.schema.json`.
export const CI_PROJECT_PROVIDERS_SCHEMA_REF =
	"ci-project-providers.schema.json";

const kubernetesName = z
	.string()
	.regex(/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/)
	.meta({ id: "KubernetesName" });
const base = {
	id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
	connectionRef: z.string().regex(/^[A-Za-z0-9_.:/-]{1,200}$/),
	runsOn: z.string().regex(/^(?![Hh][Oo][Bb][Oo]$)[A-Za-z0-9_.-]{1,100}$/),
	enabled: z.boolean().optional(),
};

/**
 * An ARC `AutoscalingRunnerSet` HoBo thinly reconciles. `name` is its
 * `runnerScaleSetName`; HoBo never installs or upgrades the ARC controller.
 */
export const CiKubernetesScaleSetSchema = z
	.object({
		name: kubernetesName,
		minRunners: z.number().int().min(0).max(1000).optional(),
		maxRunners: z.number().int().min(1).max(1000),
		namespace: kubernetesName,
	})
	.strict()
	.refine((scaleSet) => (scaleSet.minRunners ?? 0) <= scaleSet.maxRunners)
	.meta({ id: "KubernetesScaleSet" });
/** A Dagger Engine HoBo checks for readiness only; it never installs one. */
export const CiDaggerEngineSchema = z
	.object({ name: kubernetesName })
	.strict()
	.meta({ id: "DaggerEngine" });

const plain = <K extends string>(kind: K, id: string) =>
	z
		.object({ ...base, kind: z.literal(kind) })
		.strict()
		.meta({ id });

export const CiKubernetesProviderSchema = z
	.object({
		...base,
		kind: z.literal("kubernetes"),
		scaleSet: CiKubernetesScaleSetSchema.optional(),
		engine: CiDaggerEngineSchema.optional(),
	})
	.strict()
	.refine((provider) => !(provider.scaleSet && provider.engine), {
		message: "scaleSet and engine are mutually exclusive",
	})
	.meta({
		id: "KubernetesProvider",
		not: { required: ["scaleSet", "engine"] },
	});
export const CiVercelProviderSchema = z
	.object({
		...base,
		kind: z.literal("vercel"),
		location: z.enum(["vercel", "local", "remote"]),
	})
	.strict()
	.meta({ id: "VercelProvider" });

const agent37Hostname =
	/^(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/u;
const agent37Disk = z.number().int().min(1).max(1024);
const agent37Size = (cpu: 2 | 4 | 8, memory: 4 | 8 | 16 | 32 | 64) =>
	z
		.object({
			cpu: z.literal(cpu),
			memory: z.literal(memory),
			disk: agent37Disk,
		})
		.strict();
export const CiAgent37SizeSchema = z
	.union([
		agent37Size(2, 4),
		agent37Size(4, 8),
		agent37Size(4, 16),
		agent37Size(4, 32),
		agent37Size(8, 64),
	])
	.meta({ id: "Agent37Size" });
const agent37FreeTierLimits = [
	{ memory: 4, maxBoxes: 8 },
	{ memory: 8, maxBoxes: 4 },
	{ memory: 16, maxBoxes: 2 },
	{ memory: 32, maxBoxes: 1 },
	{ memory: 64, maxBoxes: 0 },
].map(({ memory, maxBoxes }) => ({
	anyOf: [
		{
			properties: { allowAboveFreeTier: { const: true } },
			required: ["allowAboveFreeTier"],
		},
		{
			properties: {
				size: {
					properties: { memory: { const: memory } },
					required: ["memory"],
				},
				maxBoxes: { maximum: maxBoxes },
			},
			required: ["size", "maxBoxes"],
		},
	],
}));
export const CiAgent37PoolSchema = z
	.object({
		minBoxes: z.number().int().min(0).max(1000),
		maxBoxes: z.number().int().min(1).max(1000),
		type: z.enum(["default", "vm", "performance"]),
		size: CiAgent37SizeSchema,
		region: z.enum(["us", "eu", "ap-south"]),
		template: z
			.string()
			.max(255)
			.regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}@[1-9][0-9]{0,19}$/u),
		idleTtlSeconds: z.number().int().min(60).max(3600),
		jobTimeoutSeconds: z.number().int().min(1).max(19800),
		labels: z
			.array(base.runsOn)
			.min(1)
			.max(16)
			.refine((labels) => new Set(labels).size === labels.length)
			.meta({ uniqueItems: true }),
		network: z
			.object({
				allow: z
					.array(z.string().min(1).max(253).regex(agent37Hostname))
					.max(100),
			})
			.strict(),
		budget: z
			.object({
				limitMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
				period: z.literal("month"),
				maxCreatesPerHour: z.number().int().min(1).max(10000),
			})
			.strict(),
		allowAboveFreeTier: z.boolean().optional(),
	})
	.strict()
	.superRefine((pool, context) => {
		if (pool.minBoxes > pool.maxBoxes)
			context.addIssue({
				code: "custom",
				path: ["minBoxes"],
				message: "minBoxes exceeds maxBoxes",
			});
		if (pool.region !== "us" && pool.type === "default")
			context.addIssue({
				code: "custom",
				path: ["type"],
				message: "default boxes are available only in us",
			});
		if (pool.type === "default" && pool.size.cpu === 8)
			context.addIssue({
				code: "custom",
				path: ["size"],
				message: "8 vCPU boxes require vm or performance",
			});
		if (
			pool.maxBoxes * pool.size.memory > 32 &&
			pool.allowAboveFreeTier !== true
		)
			context.addIssue({
				code: "custom",
				path: ["maxBoxes"],
				message: "pool exceeds the 32 GB free-tier ceiling",
			});
	})
	.meta({
		id: "Agent37Pool",
		allOf: [
			{
				not: {
					properties: {
						region: { enum: ["eu", "ap-south"] },
						type: { const: "default" },
					},
					required: ["region", "type"],
				},
			},
			{
				not: {
					properties: {
						type: { const: "default" },
						size: { properties: { cpu: { const: 8 } }, required: ["cpu"] },
					},
					required: ["type", "size"],
				},
			},
			...agent37FreeTierLimits,
		],
	});
export const CiAgent37ProviderSchema = z
	.object({ ...base, kind: z.literal("agent37"), pool: CiAgent37PoolSchema })
	.strict()
	.meta({ id: "Agent37Provider" });

/** Closed, kind-discriminated provider shapes for `.hobo/ci.json`. */
export const CiProjectProviderSchema = z
	.discriminatedUnion("kind", [
		plain("local", "LocalProvider"),
		plain("github", "GithubProvider"),
		plain("blacksmith", "BlacksmithProvider"),
		plain("depot", "DepotProvider"),
		plain("warpbuild", "WarpbuildProvider"),
		CiKubernetesProviderSchema,
		plain("hobo-box-worker", "HoboBoxWorkerProvider"),
		CiVercelProviderSchema,
		CiAgent37ProviderSchema,
	])
	.meta({ id: "Provider" });

export type CiProjectProvider = z.infer<typeof CiProjectProviderSchema>;
export type CiProjectProviderKind = CiProjectProvider["kind"];
export type CiKubernetesProvider = z.infer<typeof CiKubernetesProviderSchema>;
export type CiKubernetesScaleSet = z.infer<typeof CiKubernetesScaleSetSchema>;
export type CiDaggerEngine = z.infer<typeof CiDaggerEngineSchema>;
export type CiVercelProvider = z.infer<typeof CiVercelProviderSchema>;
export type CiVercelLocation = CiVercelProvider["location"];
export type CiAgent37Provider = z.infer<typeof CiAgent37ProviderSchema>;
export type CiAgent37Pool = z.infer<typeof CiAgent37PoolSchema>;

/** The shipped provider schema, referenced by `ci-project.schema.json`. */
export function ciProjectProvidersJsonSchema() {
	return {
		...z.toJSONSchema(CiProjectProviderSchema, {
			target: "draft-2020-12",
			reused: "ref",
		}),
		$id: CI_PROJECT_PROVIDERS_SCHEMA_ID,
		title: "HoBo CI provider",
	};
}
