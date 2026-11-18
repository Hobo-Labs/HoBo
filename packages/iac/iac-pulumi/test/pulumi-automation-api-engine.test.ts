import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	createPulumiAutomationAdapter,
	createPulumiAutomationApiEngine,
	createTrivialIacProgram,
	PINNED_PULUMI_AUTOMATION_VERSION,
	PULUMI_CLI_MISSING,
	PulumiEngineUnavailableError,
} from "../src/index.js";
import type { JsonValue } from "../src/json.js";

function freshWorkDir(): string {
	return mkdtempSync(join(tmpdir(), "hobo-pulumi-auto-"));
}

function pulumiBinaryAvailable(): boolean {
	try {
		execFileSync("pulumi", ["version"], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

const CLOUDFLARE_PROGRAM = createTrivialIacProgram({
	resources: [
		{
			name: "sessions",
			type: "cloudflare:kv-namespace",
			provider: "cloudflare",
			inputs: {},
			outputs: ["namespaceId", "binding"],
		},
	],
	stackOutputs: {},
});

describe("createPulumiAutomationApiEngine", () => {
	it("speaks the shared engine shape and pins the toolchain version", () => {
		const engine = createPulumiAutomationApiEngine({
			workDir: freshWorkDir(),
		});
		expect(engine.pulumiVersion).toBe(PINNED_PULUMI_AUTOMATION_VERSION);
		for (const operation of [
			"preview",
			"apply",
			"refresh",
			"destroy",
			"snapshot",
		] as const) {
			expect(engine[operation] instanceof Function).toBe(true);
		}
	});

	it("is accepted by createPulumiAutomationAdapter (same seam as the other engines)", () => {
		const adapter = createPulumiAutomationAdapter({
			engine: createPulumiAutomationApiEngine({ workDir: freshWorkDir() }),
		});
		expect(adapter.pulumiVersion).toBe(PINNED_PULUMI_AUTOMATION_VERSION);
	});

	it("snapshot() of an empty estate is empty (no engine invocation needed)", () => {
		const engine = createPulumiAutomationApiEngine({
			workDir: freshWorkDir(),
		});
		expect(engine.snapshot()).toEqual({});
	});

	it("fails closed with the typed unavailable error when the pulumi engine is missing", async () => {
		const engine = createPulumiAutomationApiEngine({
			workDir: freshWorkDir(),

			env: { PATH: "/nonexistent", PULUMI_CONFIG_PASSPHRASE: "" },
		});
		await expect(engine.preview(CLOUDFLARE_PROGRAM)).rejects.toSatisfy(
			(error: JsonValue) =>
				error instanceof PulumiEngineUnavailableError &&
				error.code === PULUMI_CLI_MISSING,
		);
	});

	it("maps an injected automation module's workspace failure to the typed error", async () => {
		const engine = createPulumiAutomationApiEngine({
			workDir: freshWorkDir(),
			automation: {
				LocalWorkspace: {
					createOrSelectStack: async () => {
						throw new Error("engine binary not found");
					},
				},
			},
		});
		await expect(engine.preview(CLOUDFLARE_PROGRAM)).rejects.toSatisfy(
			(error: JsonValue) =>
				error instanceof PulumiEngineUnavailableError &&
				error.code === PULUMI_CLI_MISSING,
		);
	});

	it("drives preview/apply/refresh/destroy through an injected LocalWorkspace seam", async () => {
		const calls: string[] = [];
		const stackFor = () => ({
			async preview() {
				calls.push("preview");
				return { changeSummary: { create: 1 } };
			},
			async up() {
				calls.push("up");
			},
			async refresh() {
				calls.push("refresh");
			},
			async destroy() {
				calls.push("destroy");
			},
			async outputs() {
				return {
					namespaceId: { value: "ns-123" },
					binding: { value: "sessions" },
				};
			},
		});
		const engine = createPulumiAutomationApiEngine({
			workDir: freshWorkDir(),
			automation: {
				LocalWorkspace: {
					createOrSelectStack: async () => stackFor(),
				},
			},
		});

		const preview = await engine.preview(CLOUDFLARE_PROGRAM);
		expect(preview.dirty).toBe(true);
		expect(preview.changes[0]).toMatchObject({
			op: "create",
			resource: "sessions",
		});

		const applied = await engine.apply(CLOUDFLARE_PROGRAM, preview.changes);
		expect(applied.outputs.resources.sessions).toMatchObject({
			status: "provisioned",
			outputs: { namespaceId: "ns-123", binding: "sessions" },
		});
		expect(applied.outputs.bindings["sessions.namespaceId"]).toBe("ns-123");

		const destroyed = await engine.destroy(CLOUDFLARE_PROGRAM);
		expect(destroyed.resources.sessions).toMatchObject({
			status: "destroyed",
		});
		expect(calls).toContain("up");
		expect(calls).toContain("destroy");
	});

	it.runIf(pulumiBinaryAvailable())(
		"runs a real Pulumi preview in an isolated local workspace",
		async () => {
			const workDir = freshWorkDir();
			try {
				const engine = createPulumiAutomationApiEngine({
					workDir,
					env: {
						PATH: process.env.PATH,
						PULUMI_HOME: join(workDir, "pulumi-home"),
						PULUMI_CONFIG_PASSPHRASE: "",
						PULUMI_SKIP_UPDATE_CHECK: "true",
						PULUMI_DISABLE_AUTOMATIC_PLUGIN_ACQUISITION: "true",
						CLOUDFLARE_API_TOKEN: "",
						CLOUDFLARE_API_KEY: "",
					},
				});
				await expect(engine.preview(CLOUDFLARE_PROGRAM)).rejects.toThrow(
					/no resource plugin 'pulumi-resource-cloudflare'/u,
				);
			} finally {
				rmSync(workDir, { recursive: true, force: true });
			}
		},
		120_000,
	);
});
