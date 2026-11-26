import { create, type JsonObject } from "@bufbuild/protobuf";
import {
	PipelineResultSchema,
	PipelineStepResultSchema,
	parsePipeline,
} from "@hobo/ci/execution";
import { describe, expect, it } from "vitest";
import { adoTarget } from "../../contracts/fixtures/pact-broker.js";
import { redactResult, resolveEnvironment } from "../../src/environment.js";
import { parseAdoLiveTarget, parseAdoProject } from "../../src/index.js";

const config = {
	schemaVersion: "hobo.ci.ado/v1",
	pool: "hobo-local",
	pipelinePath: "pipeline.json",
	artifactPrefix: "hobo",
};
const project = (fields: JsonObject) =>
	parseAdoProject(JSON.stringify({ ...config, ...fields }));
const pipeline = (env: Record<string, string> = {}) =>
	parsePipeline(
		JSON.stringify({
			id: "edge",
			accountId: "local",
			timeoutSeconds: 1,
			steps: [{ id: "one", argv: ["node", "--version"], env }],
		}),
	);

describe("project authoring limits", () => {
	it.each([
		["pool", "a".repeat(100), "a".repeat(101)],
		["artifactPrefix", "a".repeat(64), "a".repeat(65)],
		[
			"pipelinePath",
			`${"a".repeat(250)}/${"b".repeat(249)}`,
			`${"a".repeat(250)}/${"b".repeat(250)}`,
		],
	] as const)("accepts the %s limit and rejects one beyond it", (field, accepted, rejected) => {
		expect(() => project({ [field]: accepted })).not.toThrow();
		expect(() => project({ [field]: rejected })).toThrow();
	});
	it("bounds counts of demands, bindings and command arguments", () => {
		const demands = Array.from({ length: 16 }, (_, i) => `capability${i}`);
		expect(() => project({ demands })).not.toThrow();
		expect(() => project({ demands: [...demands, "extra"] })).toThrow();
		const refs = Object.fromEntries(
			Array.from({ length: 64 }, (_, i) => [`TARGET_${i}`, `SOURCE_${i}`]),
		);
		expect(() => project({ environmentRefs: refs })).not.toThrow();
		expect(() =>
			project({ environmentRefs: { ...refs, EXTRA: "EXTRA_SOURCE" } }),
		).toThrow();
		for (const field of ["runnerArgv", "bootstrapArgv"]) {
			expect(() => project({ [field]: Array(256).fill("arg") })).not.toThrow();
			expect(() => project({ [field]: Array(257).fill("arg") })).toThrow();
		}
	});
	it("bounds total command text and rejects NUL or Azure expressions", () => {
		expect(() =>
			project({ runnerArgv: ["node", "x".repeat(65532)] }),
		).not.toThrow();
		expect(() =>
			project({ runnerArgv: ["node", "x".repeat(65533)] }),
		).toThrow();
		for (const argument of ["", "bad\0arg", "$(VAR)", "${{ VAR }}", "$[VAR]"])
			expect(() => project({ runnerArgv: ["node", argument] })).toThrow();
	});
	it.each([
		{ pool: " hobo" },
		{ pool: "hobo " },
		{ pool: "AZURE PIPELINES" },
		{ pool: "bad\nname" },
		{ pipelinePath: "../outside" },
		{ pipelinePath: "a/../b" },
		{ pipelinePath: "a//b" },
		{ pipelinePath: "a/" },
		{ pipelinePath: "a\\b" },
		{ pipelinePath: "a b" },
		{ pipelinePath: "${{ value }}" },
		{ demands: ["Agent.OS"] },
		{ demands: ["agent.os -equals Linux"] },
		{ demands: ["Agent.OS -equals Windows"] },
		{ environmentRefs: { "BAD-NAME": "SOURCE" } },
		{ environmentRefs: { TARGET: "BAD-NAME" } },
		{ environmentRefs: { HOBO_CI_METADATA: "SOURCE" } },
		{ environmentRefs: { TARGET: "HOBO_CI_METADATA" } },
		{ unknownField: true },
	])("rejects invalid authoring %j", (fields) => {
		expect(() => project(fields)).toThrow();
	});
	it("bounds environment names and freezes nested executable intent", () => {
		expect(() =>
			project({ environmentRefs: { ["A".repeat(128)]: "SOURCE" } }),
		).not.toThrow();
		expect(() =>
			project({ environmentRefs: { ["A".repeat(129)]: "SOURCE" } }),
		).toThrow();
		const parsed = project({});
		for (const value of [
			parsed,
			parsed.demands,
			parsed.environmentRefs,
			parsed.runnerArgv,
			parsed.bootstrapArgv,
		])
			expect(Object.isFrozen(value)).toBe(true);
		expect(parsed.verifyArtifacts).toBe(true);
		expect(project({ verifyArtifacts: false }).verifyArtifacts).toBe(false);
	});
});

describe("live target authoring", () => {
	it.each([
		{ refName: "refs/heads//main" },
		{ refName: "refs/heads/main/" },
		{ refName: "refs/heads/.hidden" },
		{ refName: "refs/heads/folder/.hidden" },
		{ refName: "refs/heads/main.lock" },
		{ refName: "refs/heads/a.lock/b" },
		{ refName: "refs/heads/main." },
		{ refName: "refs/heads/main..other" },
		{ refName: "refs/tags/v1" },
		{ organizationUrl: "https://dev.azure.com/org?extra=1" },
		{ organizationUrl: "https://user@dev.azure.com/org" },
		{ organizationUrl: "https://dev.azure.com/org/other" },
		{ project: "trailing " },
		{ project: " leading" },
		{ pipelineId: 0 },
		{ pipelineId: -1 },
		{ pipelineId: 1.5 },
		{ pipelineId: 2 ** 32 },
		{ sourceVersion: "A".repeat(40) },
		{ authentication: "basic" },
		{ tokenEnv: "9BAD" },
		{ timeoutSeconds: 3601 },
		{ timeoutSeconds: 0 },
		{ unknownField: true },
	])("refuses unsafe or unsupported target %j", (fields) => {
		expect(() =>
			parseAdoLiveTarget(JSON.stringify({ ...adoTarget, ...fields })),
		).toThrow();
	});
	it("normalizes the organization slash and supports nested branches and spaced projects", () => {
		const parsed = parseAdoLiveTarget(
			JSON.stringify({
				...adoTarget,
				organizationUrl: `${adoTarget.organizationUrl}/`,
				refName: "refs/heads/features/ci-ado",
				project: "HoBo Project",
			}),
		);
		expect(parsed.organizationUrl).toBe(adoTarget.organizationUrl);
		expect(Object.isFrozen(parsed)).toBe(true);
	});
});

describe("environment binding edges", () => {
	it.each([
		{ HOBO_CI_INTERNAL: "SOURCE" },
		{ TOKEN: "HOBO_CI_INTERNAL" },
		{ "BAD-NAME": "SOURCE" },
		{ TOKEN: "BAD-NAME" },
	])("refuses invalid direct binding names %j", (refs) => {
		expect(() =>
			resolveEnvironment(refs, pipeline(), { SOURCE: "secret" }),
		).toThrow();
	});
	it.each([
		"bad\0secret",
		"x".repeat(65537),
	])("rejects invalid secret content %#", (value) => {
		expect(() =>
			resolveEnvironment({ TOKEN: "SOURCE" }, pipeline(), { SOURCE: value }),
		).toThrow(/environment reference/);
	});
	it("accepts the explicit 65536-character boundary", () => {
		const value = "x".repeat(65536);
		expect(
			resolveEnvironment({ TOKEN: "SOURCE" }, pipeline(), { SOURCE: value })
				.TOKEN,
		).toBe(value);
	});
	it("refuses inherited source bindings and literal conflicts", () => {
		const host: NodeJS.ProcessEnv = {};
		Object.setPrototypeOf(host, { SOURCE: "secret" });
		expect(() =>
			resolveEnvironment({ TOKEN: "SOURCE" }, pipeline(), host),
		).toThrow(/environment reference/);
		expect(() =>
			resolveEnvironment({ TOKEN: "SOURCE" }, pipeline({ TOKEN: "literal" }), {
				SOURCE: "secret",
			}),
		).toThrow(/conflicts/);
	});
	it("rejects a prototype key before protobuf can silently discard its binding", () => {
		const refs = JSON.parse('{"__proto__":"SOURCE"}');
		expect(() => project({ environmentRefs: refs })).toThrow(/prototype/);
	});
	it("creates an ordinary own property for a constructor-named binding", () => {
		const parsed = project({ environmentRefs: { constructor: "SOURCE" } });
		const env = resolveEnvironment(parsed.environmentRefs, pipeline(), {
			SOURCE: "secret",
		});
		expect(Object.getPrototypeOf(env)).toBe(Object.prototype);
		expect(Object.hasOwn(env, "__proto__")).toBe(false);
		expect(env.constructor).toBe("secret");
	});
	it("masks overlapping and multiline values in every captured text field", () => {
		const text = "long-secret short\nmultiline\nsecret";
		const result = create(PipelineResultSchema, {
			id: "edge",
			status: "failed",
			error: text,
			steps: [
				create(PipelineStepResultSchema, {
					id: "one",
					exitCode: 1,
					stdout: text,
					stderr: text,
				}),
			],
		});
		const masked = redactResult(result, [
			"secret",
			"long-secret",
			"multiline\nsecret",
			"",
			"short",
			"short",
		]);
		for (const value of [
			masked.error,
			masked.steps[0]?.stdout,
			masked.steps[0]?.stderr,
		])
			expect(value).toBe("*** ***\n***");
		expect(result.error).toBe(text);
	});
});
