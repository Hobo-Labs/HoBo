import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ALWAYS_PROTECTED_PATHS,
	agentPolicies,
	matchesAnyPath,
	parseAgentConfig,
} from "../src/config.js";

const fixtures = join(import.meta.dirname, "../data-models/fixtures");
const configs = (kind: "valid" | "invalid") =>
	readdirSync(join(fixtures, kind))
		.filter((name) => name.startsWith("config-"))
		.map((name) => [name, readFileSync(join(fixtures, kind, name), "utf8")]);

describe("agent configuration", () => {
	it.each(
		configs("valid"),
	)("parses the CUE-valid fixture %s", (_name, json) => {
		const config = parseAgentConfig(json);
		expect(Object.isFrozen(config)).toBe(true);
		expect(agentPolicies(config).resolution.protectedPaths).toEqual(
			expect.arrayContaining([...ALWAYS_PROTECTED_PATHS]),
		);
	});

	it.each(
		configs("invalid"),
	)("rejects the CUE-invalid fixture %s", (_name, json) => {
		expect(() => parseAgentConfig(json)).toThrow(
			"invalid CI agent configuration",
		);
	});

	it("parses the shipped example block", () => {
		const example = JSON.parse(
			readFileSync(join(import.meta.dirname, "../examples/ci.json"), "utf8"),
		);
		expect(parseAgentConfig(JSON.stringify(example.agent)).mode).toBe(
			"suggest",
		);
	});

	it("defaults to the conservative end of every range", () => {
		const config = parseAgentConfig(
			JSON.stringify({
				mode: "observe",
				engines: [{ id: "m", kind: "anthropic", model: "claude-sonnet-4-5" }],
			}),
		);
		const { queue, resolution, budget } = agentPolicies(config);
		expect(queue).toMatchObject({
			maxBatchSize: 4,
			rollup: false,
			label: "hobo-queue",
		});
		expect(resolution).toMatchObject({
			minConfidence: 0.8,
			maxConflictedFiles: 5,
		});
		expect(budget).toMatchObject({
			maxResolutionsPerTick: 2,
			timeoutSeconds: 120,
		});
	});

	it("never echoes authored text in an error", () => {
		const secret = "sk-ant-api03-SECRETSECRETSECRET";
		let message = "";
		try {
			parseAgentConfig(
				JSON.stringify({
					mode: "observe",
					engines: [
						{ id: "m", kind: "anthropic", model: "x", credential: secret },
					],
				}),
			);
		} catch (error) {
			message = error instanceof Error ? error.message : "";
		}
		expect(message).toBe("invalid CI agent configuration");
	});

	it("rejects duplicate engine ids, unknown fields and oversized input", () => {
		const engine = { id: "m", kind: "gateway", model: "openai/gpt-5.1" };
		for (const document of [
			{ mode: "observe", engines: [engine, engine] },
			{ mode: "observe", engines: [engine], autoMerge: true },
			{ mode: "observe", engines: [{ ...engine, kind: "harness" }] },
			{
				mode: "observe",
				engines: [{ ...engine, baseUrl: "https://x.example/v1" }],
			},
		])
			expect(() => parseAgentConfig(JSON.stringify(document))).toThrow();
		expect(() => parseAgentConfig(" ".repeat(70_000))).toThrow();
	});

	it("matches protected paths at any depth", () => {
		const globs = [...ALWAYS_PROTECTED_PATHS, "**/migrations/**", "docs/*.md"];
		for (const path of [
			"pnpm-lock.yaml",
			"packages/app/pnpm-lock.yaml",
			".github/workflows/ci.yml",
			".hobo/ci.json",
			"CODEOWNERS",
			"docs/CODEOWNERS",
			"db/migrations/0001_init.sql",
			"docs/readme.md",
		])
			expect(matchesAnyPath(path, globs), path).toBe(true);
		for (const path of [
			"src/pnpm-lock.yaml.ts",
			"docs/guide/readme.md",
			"src/github/workflows.ts",
			"src/a.b",
		])
			expect(matchesAnyPath(path, globs), path).toBe(false);
	});
});
