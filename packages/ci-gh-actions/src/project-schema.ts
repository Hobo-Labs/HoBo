import { z } from "zod";

const name = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const CiSecretRequirementSchema = z
	.object({
		requiredFor: z
			.array(z.enum(["deployment", "execution"]))
			.min(1)
			.max(2)
			.refine((phases) => new Set(phases).size === phases.length)
			.meta({ uniqueItems: true }),
	})
	.strict();
const secrets = z
	.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), CiSecretRequirementSchema)
	.refine((entries) => Object.keys(entries).length <= 64)
	.meta({ id: "SecretRequirements", maxProperties: 64 });
const pool = z
	.object({
		label: z.literal("hobo"),
		os: z.literal("linux"),
		architecture: z.literal("x64"),
	})
	.strict()
	.meta({ id: "Pool" });
const routing = z
	.object({
		strategy: z.literal("lowest-total-incremental-cost"),
		noEligibleProvider: z.literal("queue"),
		unknownAllocation: z.literal("zero"),
	})
	.strict()
	.meta({ id: "Routing" });
const budget = z
	.object({
		scope: z.literal("ci-account"),
		currency: z.literal("USD"),
		limitMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		period: z.literal("manual"),
		timeZone: z.literal("UTC"),
	})
	.strict()
	.meta({ id: "Budget" });
const provider = z
	.object({
		id,
		kind: z.enum([
			"github",
			"blacksmith",
			"depot",
			"warpbuild",
			"kubernetes",
			"hobo-box-worker",
			"local",
			"vercel",
		]),
		connectionRef: z.string().regex(/^[A-Za-z0-9_.:/-]{1,200}$/),
		runsOn: z.string().regex(/^(?![Hh][Oo][Bb][Oo]$)[A-Za-z0-9_.-]{1,100}$/),
		enabled: z.boolean().optional(),
	})
	.strict()
	.meta({ id: "Provider" });
const threshold = z
	.object({ fraction: z.number().gt(0).max(1), allow: z.array(id) })
	.strict();
const reference = (category: string) =>
	z
		.object({
			$ref: z
				.string()
				.regex(
					new RegExp(`^#/definitions/${category}/[A-Za-z][A-Za-z0-9_-]{0,63}$`),
				),
		})
		.strict();
const policy = z
	.object({
		accountId: id,
		tenantId: id,
		pool: z.union([pool, reference("pools")]),
		routing: z.union([routing, reference("routing")]),
		budget: z.union([budget, reference("budgets")]),
		providers: z
			.array(z.union([provider, reference("providers")]))
			.min(1)
			.max(100),
		thresholds: z.array(threshold).max(100).optional(),
	})
	.strict()
	.meta({ id: "Policy" });
// Legacy templates permit partial object fragments, but keep every field typed.
const partialPolicy = policy
	.extend({
		pool: z.union([pool.partial(), reference("pools")]).optional(),
		routing: z.union([routing.partial(), reference("routing")]).optional(),
		budget: z.union([budget.partial(), reference("budgets")]).optional(),
	})
	.partial();
const jobAdmission = z.enum(["push", "pull"]);
const ciEngineId = z
	.string()
	.regex(/^[a-z][a-z0-9-]{0,62}$/)
	.meta({ id: "CiEngineId" });
const engineRelayOverride = z
	.object({
		relayOrigin: z.string().min(1).max(2048).optional(),
	})
	.strict()
	.meta({ id: "EngineRelayOverride" });
const environmentEngines = z.union([
	z.array(ciEngineId).max(16),
	z
		.record(ciEngineId, engineRelayOverride.partial())
		.refine((entries) => Object.keys(entries).length <= 16),
]);
const selectionMatch = z
	.object({
		refPrefix: z.string().min(1).max(200).optional(),
		branch: z.string().min(1).max(255).optional(),
		events: z.array(z.string().min(1).max(100)).max(16).optional(),
	})
	.strict();
const selectionRule = z
	.object({
		environment: name,
		match: selectionMatch.optional(),
	})
	.strict();
const selection = z
	.object({
		rules: z.array(selectionRule).max(32).optional(),
		forkPullRequestEnvironment: name.optional(),
	})
	.strict();
const fields = z
	.object({
		relayOrigin: z.string().min(1).max(2048),
		githubWebhookOrigin: z.string().min(1).max(2048).optional(),
		allowInsecureLoopback: z.boolean().optional(),
		jobAdmission: jobAdmission.optional(),
		engines: environmentEngines.optional(),
		engineRelays: z
			.record(ciEngineId, engineRelayOverride)
			.refine((entries) => Object.keys(entries).length <= 16)
			.optional(),
		secrets: z.union([secrets, reference("secrets")]).optional(),
		policy,
	})
	.strict();
const template = fields
	.extend({ policy: partialPolicy.optional() })
	.partial()
	.strict();
const registry = <T extends z.ZodType>(value: T) =>
	z
		.record(name, value)
		.refine((entries) => Object.keys(entries).length <= 32)
		.meta({ maxProperties: 32 });
const definitions = z
	.object({
		pools: registry(pool).optional(),
		routing: registry(routing).optional(),
		budgets: registry(budget).optional(),
		providers: registry(provider).optional(),
		secrets: registry(secrets).optional(),
	})
	.strict()
	.meta({ id: "Definitions" });
export const CiProjectDocumentSchema = z
	.object({
		$schema: z.string().max(2048).optional(),
		defaultEnvironment: name.optional(),
		selection: selection.optional(),
		definitions: definitions.optional(),
		templates: z
			.record(name, template)
			.refine((entries) => Object.keys(entries).length <= 32)
			.meta({ maxProperties: 32 })
			.optional(),
		environments: z
			.record(
				name,
				z.union([fields, template.extend({ extends: name }).strict()]),
			)
			.refine((entries) => Object.keys(entries).length <= 32)
			.meta({ maxProperties: 32 })
			.optional(),
	})
	.strict();

/** The shipped editor schema and runtime parser share this authoring contract. */
export function ciProjectJsonSchema() {
	return {
		...z.toJSONSchema(CiProjectDocumentSchema, {
			target: "draft-2020-12",
			reused: "ref",
		}),
		$id: "https://raw.githubusercontent.com/Hobo-Labs/HoBo/main/packages/ci-gh-actions/schema/ci-project.schema.json",
		title: "HoBo CI project configuration",
	};
}

type JsonData = z.infer<ReturnType<typeof z.json>>;
const object = z.record(z.string(), z.json());
const referencePattern =
	/^#\/definitions\/(pools|routing|budgets|providers|secrets)\/([A-Za-z][A-Za-z0-9_-]{0,63})$/;

/** Resolve only validated, concrete, local component definitions. Never performs I/O. */
export function resolveCiProjectReferences(
	input: z.infer<typeof CiProjectDocumentSchema>,
): JsonData {
	const definitionsValue = object.parse(input.definitions ?? {});
	function expand(value: JsonData, depth: number): JsonData {
		if (depth > 32) throw new Error("configuration nesting too deep");
		if (Array.isArray(value))
			return value.map((entry) => expand(entry, depth + 1));
		const record = object.safeParse(value);
		if (!record.success) return value;
		if (Object.hasOwn(record.data, "$ref")) {
			const ref = z.string().parse(record.data.$ref);
			const match = referencePattern.exec(ref);
			const category = match?.[1],
				key = match?.[2];
			if (!category || !key) throw new Error("invalid component reference");
			const registry = object.parse(definitionsValue[category] ?? {});
			if (!Object.hasOwn(registry, key))
				throw new Error("missing component reference");
			const found = registry[key];
			if (found === undefined) throw new Error("missing component definition");
			return found;
		}
		return Object.fromEntries(
			Object.entries(record.data).map(([key, entry]) => [
				key,
				expand(entry, depth + 1),
			]),
		);
	}
	const { definitions: _definitions, $schema: _schema, ...document } = input;
	return expand(z.json().parse(document), 0);
}
