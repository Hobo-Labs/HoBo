import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	parseCiProjectConfig,
	selectCiEnvironment,
} from "../src/project-config.js";
import {
	CI_PROJECT_PROVIDERS_SCHEMA_REF,
	CiAgent37ProviderSchema,
	CiProjectProviderSchema,
	ciProjectProvidersJsonSchema,
} from "../src/project-providers.js";
import { ciProjectJsonSchema } from "../src/project-schema.js";

const KINDS = [
	"local",
	"github",
	"blacksmith",
	"depot",
	"warpbuild",
	"kubernetes",
	"hobo-box-worker",
	"vercel",
	"agent37",
] as const;
const scaleSet = {
	name: "hobo-arc",
	minRunners: 0,
	maxRunners: 4,
	namespace: "arc-runners",
};
const engine = { name: "dagger-engine" };

type Json = z.infer<ReturnType<typeof z.json>>;
type ProviderInput = Record<string, Json>;

function policyFixture(kind: "valid" | "invalid", name: string) {
	return JSON.parse(
		readFileSync(
			new URL(
				`../../ci/data-models/fixtures/${kind}/${name}.json`,
				import.meta.url,
			),
			"utf8",
		),
	);
}

function agent37Provider(kind: "valid" | "invalid", name: string) {
	return z
		.record(z.string(), z.json())
		.parse(policyFixture(kind, name).providers[0]);
}

function provider(kind: string, extra: ProviderInput = {}) {
	const base = {
		id: `${kind}-provider`,
		kind,
		connectionRef: `yard:${kind}`,
		runsOn: kind === "local" ? "hobo-local-host" : "hobo-arc",
		enabled: true,
	};
	const located = kind === "vercel" ? { ...base, location: "vercel" } : base;
	const configured =
		kind === "agent37"
			? {
					...located,
					pool: agent37Provider("valid", "desired-policy-agent37").pool,
				}
			: located;
	return { ...configured, ...extra };
}

function project(providers: readonly ProviderInput[]) {
	return JSON.stringify({
		defaultEnvironment: "remote",
		environments: {
			remote: {
				relayOrigin: "https://ci.example.com",
				policy: {
					accountId: "acme",
					tenantId: "acme",
					pool: { label: "hobo", os: "linux", architecture: "x64" },
					providers,
					budget: {
						scope: "ci-account",
						currency: "USD",
						limitMicros: 0,
						period: "manual",
						timeZone: "UTC",
					},
					routing: {
						strategy: "lowest-total-incremental-cost",
						noEligibleProvider: "queue",
						unknownAllocation: "zero",
					},
				},
			},
		},
	});
}

describe("shipped provider schema", () => {
	it("ships the exact generated provider schema beside the project schema", () => {
		expect(
			JSON.parse(
				readFileSync(
					new URL(
						"../schema/ci-project-providers.schema.json",
						import.meta.url,
					),
					"utf8",
				),
			),
		).toEqual(ciProjectProvidersJsonSchema());
	});

	it("references the provider schema instead of inlining an open provider", () => {
		const schema = ciProjectJsonSchema();
		expect(schema.$defs.Provider).toEqual({
			$ref: CI_PROJECT_PROVIDERS_SCHEMA_REF,
		});
		expect(JSON.stringify(schema)).not.toContain("KubernetesScaleSet");
	});

	it("is a oneOf of nine closed kind-specific shapes", () => {
		const schema = ciProjectProvidersJsonSchema();
		expect(schema.oneOf).toHaveLength(KINDS.length);
		for (const entry of schema.oneOf ?? []) {
			const name = String(entry.$ref).replace("#/$defs/", "");
			expect(schema.$defs?.[name]).toMatchObject({
				type: "object",
				additionalProperties: false,
			});
		}
		expect(schema.$defs?.KubernetesProvider).toMatchObject({
			not: { required: ["scaleSet", "engine"] },
		});
		expect(schema.$defs?.VercelProvider).toMatchObject({
			required: expect.arrayContaining(["location"]),
		});
		expect(schema.$defs?.Agent37Provider).toMatchObject({
			required: expect.arrayContaining(["pool"]),
		});
		expect(schema.$defs?.Agent37Size?.anyOf).toHaveLength(5);
	});
});

describe("closed provider shapes", () => {
	it.each(
		KINDS.filter((kind) => kind !== "vercel"),
	)("keeps the existing five-field %s provider valid", (kind) => {
		expect(CiProjectProviderSchema.safeParse(provider(kind)).success).toBe(
			true,
		);
	});

	it.each(
		KINDS.flatMap((kind) =>
			(
				[
					["scaleSet", scaleSet],
					["engine", engine],
					["location", "local"],
				] as const
			)
				.filter(
					([field]) =>
						!(kind === "kubernetes" && field !== "location") &&
						!(kind === "vercel" && field === "location"),
				)
				.map(([field, value]) => [kind, field, value] as const),
		),
	)("rejects %s with %s", (kind, field, value) => {
		const input = provider(kind, { [field]: value });
		expect(CiProjectProviderSchema.safeParse(input).success).toBe(false);
		expect(() => parseCiProjectConfig(project([input]))).toThrow(
			"invalid CI project configuration",
		);
	});

	it("rejects a kubernetes provider declaring both scaleSet and engine", () => {
		const input = provider("kubernetes", { scaleSet, engine });
		expect(CiProjectProviderSchema.safeParse(input).success).toBe(false);
		expect(() => parseCiProjectConfig(project([input]))).toThrow(
			"invalid CI project configuration",
		);
	});

	it("requires a vercel location from the closed vercel|local|remote set", () => {
		const { location: _location, ...missing } = provider("vercel");
		expect(CiProjectProviderSchema.safeParse(missing).success).toBe(false);
		expect(
			CiProjectProviderSchema.safeParse(
				provider("vercel", { location: "edge" }),
			).success,
		).toBe(false);
		for (const location of ["vercel", "local", "remote"])
			expect(
				CiProjectProviderSchema.safeParse(provider("vercel", { location }))
					.success,
			).toBe(true);
	});

	it.each([
		["minRunners above maxRunners", { ...scaleSet, minRunners: 9 }],
		["no maxRunners", { name: "hobo-arc", namespace: "arc" }],
		["an unknown field", { ...scaleSet, template: {} }],
		["a non-DNS name", { ...scaleSet, name: "Hobo_ARC" }],
	])("rejects a scale set with %s", (_label, value) => {
		expect(
			CiProjectProviderSchema.safeParse(
				provider("kubernetes", { scaleSet: value }),
			).success,
		).toBe(false);
	});

	it("carries typed scale set, engine and location into the parsed policy", () => {
		const config = parseCiProjectConfig(
			project([
				provider("kubernetes", { id: "arc", scaleSet }),
				provider("kubernetes", { id: "dagger", engine }),
				provider("kubernetes", { id: "pods" }),
				provider("vercel", { id: "vc", location: "remote" }),
			]),
		);
		const [arc, dagger, pods, vercel] = selectCiEnvironment(config, "remote")
			.policy.providers;
		expect(arc?.capacity).toMatchObject({ case: "scaleSet", value: scaleSet });
		expect(dagger?.capacity).toMatchObject({ case: "engine", value: engine });
		// Neither field: the existing disposable-pod path.
		expect(pods?.capacity.case).toBeUndefined();
		expect(vercel?.location).toBe("remote");
	});

	it("carries the shared Agent37 fixture into the parsed policy", () => {
		const input = agent37Provider("valid", "desired-policy-agent37");
		expect(CiProjectProviderSchema.safeParse(input).success).toBe(true);
		const config = parseCiProjectConfig(project([input]));
		expect(
			selectCiEnvironment(config, "remote").policy.providers[0]?.capacity,
		).toMatchObject({
			case: "pool",
			value: {
				maxBoxes: 4,
				type: "vm",
				region: "us",
				template: "agent37-ubuntu@1",
				budget: { limitMicros: 2000000, maxCreatesPerHour: 60 },
			},
		});
	});

	it.each([
		"agent37-ubuntu",
		"agent37-ubuntu@latest",
		"agent37-ubuntu@",
		"agent37-ubuntu@1.2",
		"agent37-ubuntu@0",
	])("requires an immutable numeric Agent37 template revision: %s", (template) => {
		const parsed = CiAgent37ProviderSchema.parse(
			agent37Provider("valid", "desired-policy-agent37"),
		);
		const input = { ...parsed, pool: { ...parsed.pool, template } };
		expect(CiProjectProviderSchema.safeParse(input).success).toBe(false);
		expect(() => parseCiProjectConfig(project([input]))).toThrow(
			"invalid CI project configuration",
		);
	});

	it.each([
		"desired-policy-agent37-non-us-default",
		"desired-policy-agent37-oversize",
		"desired-policy-agent37-network-limit",
		"desired-policy-agent37-network-hostname",
		"desired-policy-agent37-memory-ceiling",
	])("rejects shared Agent37 fixture %s through Zod and project parsing", (name) => {
		const input = agent37Provider("invalid", name);
		expect(CiProjectProviderSchema.safeParse(input).success).toBe(false);
		expect(() => parseCiProjectConfig(project([input]))).toThrow(
			"invalid CI project configuration",
		);
	});

	it.each([
		"",
		"bad..example.com",
		"-bad.example.com",
		"bad-.example.com",
		"bad_name.example.com",
		"*.*.example.com",
		"https://github.com",
	])("rejects invalid Agent37 network entry %j in authored configuration", (entry) => {
		const parsed = CiAgent37ProviderSchema.parse(
			agent37Provider("valid", "desired-policy-agent37"),
		);
		const input = {
			...parsed,
			pool: { ...parsed.pool, network: { allow: [entry] } },
		};
		expect(CiProjectProviderSchema.safeParse(input).success).toBe(false);
	});

	it("enforces unique Agent37 labels and explicit free-tier opt-in", () => {
		const parsed = CiAgent37ProviderSchema.parse(
			agent37Provider("valid", "desired-policy-agent37"),
		);
		expect(
			CiAgent37ProviderSchema.safeParse({
				...parsed,
				pool: {
					...parsed.pool,
					labels: ["hobo-agent37", "hobo-agent37"],
				},
			}).success,
		).toBe(false);
		expect(
			CiAgent37ProviderSchema.safeParse({
				...parsed,
				pool: { ...parsed.pool, maxBoxes: 9, allowAboveFreeTier: true },
			}).success,
		).toBe(true);
	});

	it("never accepts credentials inside the typed shapes", () => {
		expect(
			CiProjectProviderSchema.safeParse(
				provider("kubernetes", {
					scaleSet: { ...scaleSet, githubConfigSecret: "s" },
				}),
			).success,
		).toBe(false);
		expect(
			CiProjectProviderSchema.safeParse(
				provider("kubernetes", { kubeconfig: "apiVersion: v1" }),
			).success,
		).toBe(false);
		expect(
			CiProjectProviderSchema.safeParse(provider("vercel", { token: "t" }))
				.success,
		).toBe(false);
	});
});
