import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCiRunnerIntegrations } from "../src/project-config.js";
import { CiProjectDocumentSchema } from "../src/project-schema.js";
import {
	buildRunnerIntegration,
	looksLikeSecret,
	RUNNER_PROVIDER_PROFILES,
	RunnerIntegrationSchema,
	redactSecrets,
} from "../src/runner-integrations.js";

// Runtime-only synthetic credentials; never persisted.
const token = (prefix: string) =>
	`${prefix}aZ9${randomBytes(30).toString("base64url").replace(/[-_]/g, "x")}`;

describe("runner integrations", () => {
	it("defaults every provider to its safest supported auth", () => {
		expect(
			Object.values(RUNNER_PROVIDER_PROFILES).map(
				(p) =>
					`${p.provider}:${buildRunnerIntegration(p.provider).auth.method}`,
			),
		).toEqual([
			"blacksmith:github-app",
			"depot:github-app",
			"jog:github-app",
			"boat:device",
		]);
	});

	it("only accepts references for secret-ref", () => {
		const base = {
			id: "depot",
			provider: "depot",
			runsOn: ["depot-ubuntu-24.04"],
		};
		expect(
			RunnerIntegrationSchema.safeParse({
				...base,
				auth: { method: "secret-ref", secretRef: "github-secret:DEPOT_TOKEN" },
			}).success,
		).toBe(true);
		for (const secretRef of [
			token("depot_org_"),
			token("ghp_"),
			"DEPOT_TOKEN",
			"env:lower",
		])
			expect(
				RunnerIntegrationSchema.safeParse({
					...base,
					auth: { method: "secret-ref", secretRef },
				}).success,
			).toBe(false);
	});

	it("rejects provider/label mismatches", () => {
		expect(() =>
			buildRunnerIntegration("blacksmith", { runsOn: ["depot-ubuntu-24.04"] }),
		).toThrow();
		expect(() =>
			buildRunnerIntegration("boat", { runsOn: ["boat-huge"] }),
		).toThrow();
	});

	it("detects and redacts credential shapes but keeps digests and references", () => {
		const secrets = [
			token("ghp_"),
			token("depot_project_"),
			token("boat_"),
			token(""),
		];
		for (const secret of secrets) {
			expect(looksLikeSecret(secret)).toBe(true);
			expect(redactSecrets(`x ${secret} y`)).toBe("x [REDACTED] y");
		}
		const sha = "b0d24bd898725c42ccd8033fba2e878a2e27a16f";
		for (const safe of [
			sha,
			"github-secret:DEPOT_TOKEN",
			"blacksmith-2vcpu-ubuntu-2404",
		]) {
			expect(looksLikeSecret(safe)).toBe(false);
			expect(redactSecrets(safe)).toBe(safe);
		}
	});

	it("the repository config declares integrations and still parses", () => {
		const json = readFileSync(
			new URL("../../../.hobo/ci.json", import.meta.url),
			"utf8",
		);
		expect(
			parseCiRunnerIntegrations(json)
				.map((i) => i.provider)
				.sort(),
		).toEqual(["blacksmith", "boat", "depot", "jog"]);
		expect(CiProjectDocumentSchema.safeParse(JSON.parse(json)).success).toBe(
			true,
		);
		const withSecret = JSON.parse(json);
		withSecret.integrations[0].organization = token("ghp_");
		expect(() => parseCiRunnerIntegrations(JSON.stringify(withSecret))).toThrow(
			/^invalid CI runner integrations/,
		);
	});
});
