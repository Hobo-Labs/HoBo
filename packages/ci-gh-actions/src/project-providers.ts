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
	])
	.meta({ id: "Provider" });

export type CiProjectProvider = z.infer<typeof CiProjectProviderSchema>;
export type CiProjectProviderKind = CiProjectProvider["kind"];
export type CiKubernetesProvider = z.infer<typeof CiKubernetesProviderSchema>;
export type CiKubernetesScaleSet = z.infer<typeof CiKubernetesScaleSetSchema>;
export type CiDaggerEngine = z.infer<typeof CiDaggerEngineSchema>;
export type CiVercelProvider = z.infer<typeof CiVercelProviderSchema>;
export type CiVercelLocation = CiVercelProvider["location"];

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
