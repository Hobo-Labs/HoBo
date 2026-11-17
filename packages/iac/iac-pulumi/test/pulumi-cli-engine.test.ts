import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
	createPulumiAutomationAdapter,
	createPulumiCliAutomationEngine,
	PULUMI_CLI_MISSING,
	PULUMI_UNSUPPORTED_RESOURCE,
	PULUMI_YAML_TYPE_TOKENS,
	PulumiEngineUnavailableError,
	renderPulumiYamlProgram,
} from "../src/index.js";

// The real CLI-backed engine. Hermetic coverage —
// program rendering, type-token gating, binary gating, and adapter
// compatibility — without requiring the pulumi binary; the live path is
// exercised by the credential-gated workflow_dispatch lane.

const workDir = mkdtempSync(join(tmpdir(), "hobo-pulumi-cli-"));

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("pulumi CLI engine (3-2)", () => {
	it("renders a real WorkersScript YAML program deterministically", () => {
		const yaml = renderPulumiYamlProgram(
			{
				name: "api",
				type: "cloudflare:workers-script",
				inputs: { options: { script: "export default {};" } },
				outputs: ["url", "scriptName", "binding"],
			},
			{ accountId: "acct-123" },
		);
		expect(yaml).toContain("type: cloudflare:WorkersScript");
		expect(yaml).toContain('"accountId":"acct-123"');
		expect(yaml).toContain('"content":"export default {};"');
		expect(yaml).toContain("scriptName: ${api.name}");
		// Deterministic: same input, same program.
		expect(
			renderPulumiYamlProgram(
				{
					name: "api",
					type: "cloudflare:workers-script",
					inputs: { options: { script: "export default {};" } },
					outputs: ["url", "scriptName", "binding"],
				},
				{ accountId: "acct-123" },
			),
		).toBe(yaml);
	});

	it("covers every realize() resource class with a real type token", () => {
		expect(Object.keys(PULUMI_YAML_TYPE_TOKENS).sort()).toEqual([
			"cloudflare:cron-trigger",
			"cloudflare:kv-namespace",
			"cloudflare:queue",
			"cloudflare:r2-bucket",
			"cloudflare:workers-script",
		]);
	});

	it("renders a Queue and a cron trigger on the Worker it runs", () => {
		const queue = renderPulumiYamlProgram(
			{ name: "jobs", type: "cloudflare:queue", outputs: ["queueName"] },
			{ accountId: "acct-123" },
		);
		expect(queue).toContain("type: cloudflare:Queue");
		expect(queue).toContain('"queueName":"jobs"');
		expect(queue).toContain("queueName: ${jobs.queueName}");
		const trigger = renderPulumiYamlProgram(
			{
				name: "repair",
				type: "cloudflare:cron-trigger",
				inputs: {
					options: { cron: "*/15 * * * *" },
					bindings: [
						{
							resource: "api",
							ref: "${resources.api.outputs.binding}",
							resourceType: "cloudflare:workers-script",
						},
					],
				},
				outputs: ["cron"],
			},
			{ accountId: "acct-123" },
		);
		expect(trigger).toContain("type: cloudflare:WorkersCronTrigger");
		expect(trigger).toContain('"scriptName":"api"');
		expect(trigger).toContain('"schedules":[{"cron":"*/15 * * * *"}]');
	});

	it("refuses a cron trigger without a cadence or a single Worker", () => {
		const unsupported = expect.objectContaining({
			code: PULUMI_UNSUPPORTED_RESOURCE,
		});
		expect(() =>
			renderPulumiYamlProgram(
				{
					name: "repair",
					type: "cloudflare:cron-trigger",
					inputs: { bindings: [{ resource: "api" }] },
				},
				{ accountId: "a" },
			),
		).toThrowError(unsupported);
		expect(() =>
			renderPulumiYamlProgram(
				{
					name: "repair",
					type: "cloudflare:cron-trigger",
					inputs: { options: { cron: "0 * * * *" }, bindings: [] },
				},
				{ accountId: "a" },
			),
		).toThrowError(unsupported);
		// The relay's repair schedule depends on a queue: not a Worker to run.
		expect(() =>
			renderPulumiYamlProgram(
				{
					name: "repair",
					type: "cloudflare:cron-trigger",
					inputs: {
						options: { cron: "0 * * * *" },
						bindings: [
							{ resource: "hobo-ci", resourceType: "cloudflare:queue" },
						],
					},
				},
				{ accountId: "a" },
			),
		).toThrowError(unsupported);
		// An untyped dependency is not assumed to be one either.
		expect(() =>
			renderPulumiYamlProgram(
				{
					name: "repair",
					type: "cloudflare:cron-trigger",
					inputs: {
						options: { cron: "0 * * * *" },
						bindings: [{ resource: "api" }],
					},
				},
				{ accountId: "a" },
			),
		).toThrowError(unsupported);
	});

	it("does not ignore malformed dependencies or accept an empty Worker name", () => {
		for (const bindings of [
			[
				{ resource: "api", resourceType: "cloudflare:workers-script" },
				"not-a-binding",
			],
			[{ resource: "", resourceType: "cloudflare:workers-script" }],
		]) {
			expect(() =>
				renderPulumiYamlProgram(
					{
						name: "repair",
						type: "cloudflare:cron-trigger",
						inputs: { options: { cron: "*/15 * * * *" }, bindings },
					},
					{ accountId: "acct-123" },
				),
			).toThrowError(
				expect.objectContaining({ code: PULUMI_UNSUPPORTED_RESOURCE }),
			);
		}
	});

	it("fails closed on resource classes with no real translation", () => {
		expect(() =>
			renderPulumiYamlProgram(
				{ name: "x", type: "hobo:trivial/greeting" },
				{ accountId: "a" },
			),
		).toThrowError(
			expect.objectContaining({ code: PULUMI_UNSUPPORTED_RESOURCE }),
		);
	});

	it("fails closed with a typed error when the pulumi binary is missing", async () => {
		const engine = createPulumiCliAutomationEngine({
			ephemeralState: true,
			workDir,
			pulumiBin: "definitely-not-pulumi-xyz",
			env: {},
		});
		await expect(
			engine.preview({
				resources: [{ name: "api", type: "cloudflare:workers-script" }],
			}),
		).rejects.toThrowError(
			expect.objectContaining({
				name: "PulumiEngineUnavailableError",
				code: PULUMI_CLI_MISSING,
			}),
		);
	});

	it("plugs into the adapter seam with the pinned version", () => {
		const engine = createPulumiCliAutomationEngine({
			ephemeralState: true,
			workDir,
			pulumiBin: "definitely-not-pulumi-xyz",
			env: {},
		});
		// The adapter accepts the engine (version pin matches) — the swap the
		// in-memory stand-in's contract note promised.
		const adapter = createPulumiAutomationAdapter({ engine });
		expect(adapter.pulumiVersion).toBe(engine.pulumiVersion);
	});

	it("engine construction alone never touches the binary", () => {
		expect(() => {
			void new PulumiEngineUnavailableError(PULUMI_CLI_MISSING, "probe");
			createPulumiCliAutomationEngine({
				ephemeralState: true,
				workDir,
				pulumiBin: "definitely-not-pulumi-xyz",
				env: {},
			});
		}).not.toThrow();
	});
});
