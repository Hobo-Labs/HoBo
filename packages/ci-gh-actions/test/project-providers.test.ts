import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type * as z from "zod";
import {
	parseCiProjectConfig,
	selectCiEnvironment,
} from "../src/project-config.js";
import {
	CI_PROJECT_PROVIDERS_SCHEMA_REF,
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
	"jog",
	"boat",
	"lizard",
	"kubernetes",
	"hobo-box-worker",
	"vercel",
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

function provider(kind: string, extra: ProviderInput = {}) {
	const base = {
		id: `${kind}-provider`,
		kind,
		connectionRef: `yard:${kind}`,
		runsOn: kind === "local" ? "hobo-local-host" : "hobo-arc",
		enabled: true,
	};
	const located = kind === "vercel" ? { ...base, location: "vercel" } : base;
	return { ...located, ...extra };
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

	it("is a oneOf of eleven closed kind-specific shapes", () => {
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
