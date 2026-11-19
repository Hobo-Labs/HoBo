import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonObject } from "../src/json.js";
import {
	createPulumiCliAutomationEngine,
	PULUMI_CLI_MISSING,
	PULUMI_UNSUPPORTED_RESOURCE,
	PULUMI_YAML_TYPE_TOKENS,
	PulumiEngineUnavailableError,
	renderPulumiYamlProgram,
} from "../src/pulumi-cli-engine.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "hobo-pulumi-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function fakePulumi(body: string): string {
	const dir = tempDir("hobo-pulumi-bin-");
	const bin = join(dir, "pulumi");
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const argv = process.argv.slice(2);",
			'if (argv[0] === "version") { process.stdout.write("v3.140.0\\n"); process.exit(0); }',
			body,
		].join("\n"),
		{ mode: 0o755 },
	);
	chmodSync(bin, 0o755);
	return bin;
}

function engine(body = "process.exit(0);") {
	return createPulumiCliAutomationEngine({
		ephemeralState: true,
		workDir: tempDir("hobo-pulumi-work-"),
		pulumiBin: fakePulumi(body),
		env: { PATH: dirname(process.execPath) },
	});
}

const program = (type = "cloudflare:kv-namespace") => ({
	deploymentId: "dep-1",
	resources: [{ name: "cache", type, outputs: ["namespaceId"] }],
});

interface RenderFixture {
	name: string;
	type: string;
	outputs?: readonly string[];
	inputs?: JsonObject;
}

const render = (
	type: string,
	outputs?: readonly string[],
	inputs?: JsonObject,
) => {
	const resource: RenderFixture = { name: "res", type };
	if (outputs !== undefined) resource.outputs = outputs;
	if (inputs !== undefined) resource.inputs = inputs;
	return renderPulumiYamlProgram(resource, { accountId: "acct-1" });
};

describe("rendering a Pulumi YAML program", () => {
	it("names the program after the resource", () => {
		expect(render("cloudflare:kv-namespace")).toContain("name: hobo-res");
	});

	it("declares the yaml runtime", () => {
		expect(render("cloudflare:kv-namespace")).toContain("runtime: yaml");
	});

	it("uses the provider's own type token", () => {
		expect(render("cloudflare:kv-namespace")).toContain(
			"type: cloudflare:WorkersKvNamespace",
		);
	});

	it("carries the account id into the properties", () => {
		expect(render("cloudflare:kv-namespace")).toContain("acct-1");
	});

	it("titles a KV namespace rather than naming it", () => {
		expect(render("cloudflare:kv-namespace")).toContain('"title":"res"');
	});

	it("names a worker script", () => {
		expect(render("cloudflare:workers-script")).toContain('"name":"res"');
	});

	it("gives a worker script a default body", () => {
		expect(render("cloudflare:workers-script")).toContain("hello from hobo");
	});

	it("keeps a supplied worker script", () => {
		expect(
			render("cloudflare:workers-script", undefined, {
				options: { script: "export default {};" },
			}),
		).toContain("export default {};");
	});

	it("ignores a non-string script and uses the default", () => {
		expect(
			render("cloudflare:workers-script", undefined, {
				options: { script: 7 },
			}),
		).toContain("hello from hobo");
	});

	it("refuses a type it cannot translate", () => {
		expect(() => render("aws:s3-bucket")).toThrow(PulumiEngineUnavailableError);
	});

	it("codes an unsupported type so a caller can branch on it", () => {
		try {
			render("aws:s3-bucket");
			expect.unreachable("expected the renderer to refuse");
		} catch (error) {
			if (!(error instanceof PulumiEngineUnavailableError)) throw error;
			expect(error.code).toBe(PULUMI_UNSUPPORTED_RESOURCE);
		}
	});

	it("renders every type it claims to support", () => {
		const required = new Map<string, JsonObject>([
			[
				"cloudflare:cron-trigger",
				{
					options: { cron: "0 * * * *" },
					bindings: [
						{ resource: "api", resourceType: "cloudflare:workers-script" },
					],
				},
			],
		]);
		for (const type of Object.keys(PULUMI_YAML_TYPE_TOKENS)) {
			expect(() => render(type, undefined, required.get(type))).not.toThrow();
		}
	});
});

describe("resolving declared outputs", () => {
	it("defaults to a binding output", () => {
		expect(render("cloudflare:kv-namespace")).toContain("binding:");
	});

	it("resolves binding to the stable resource name", () => {
		expect(render("cloudflare:kv-namespace", ["binding"])).toContain(
			'binding: "res"',
		);
	});

	it("resolves a KV namespace id from the resource", () => {
		expect(render("cloudflare:kv-namespace", ["namespaceId"])).toContain(
			"namespaceId: ${res.id}",
		);
	});

	it("resolves a worker script name from the resource", () => {
		expect(render("cloudflare:workers-script", ["scriptName"])).toContain(
			"scriptName: ${res.name}",
		);
	});

	it("resolves a worker URL as a literal, not a provider output", () => {
		expect(render("cloudflare:workers-script", ["url"])).toContain(
			"https://res.workers.dev",
		);
	});

	it("resolves an R2 bucket name from the resource", () => {
		expect(render("cloudflare:r2-bucket", ["bucketName"])).toContain(
			"bucketName: ${res.name}",
		);
	});

	it("resolves an R2 endpoint from the resource id", () => {
		expect(render("cloudflare:r2-bucket", ["endpoint"])).toContain(
			"endpoint: ${res.id}",
		);
	});

	it("falls back to the id for an output it does not know", () => {
		expect(render("cloudflare:kv-namespace", ["mystery"])).toContain(
			"mystery: ${res.id}",
		);
	});

	it("renders several outputs at once", () => {
		const yaml = render("cloudflare:workers-script", ["binding", "scriptName"]);
		expect(yaml).toContain("binding:");
		expect(yaml).toContain("scriptName:");
	});

	it("does not resolve a worker output for a KV resource", () => {
		expect(render("cloudflare:kv-namespace", ["scriptName"])).toContain(
			"scriptName: ${res.id}",
		);
	});
});

describe("gating on the CLI", () => {
	it("refuses a snapshot when the binary is missing", () => {
		const created = createPulumiCliAutomationEngine({
			ephemeralState: true,
			workDir: tempDir(),
			pulumiBin: join(tempDir(), "not-installed"),
			env: { PATH: dirname(process.execPath) },
		});
		expect(() => created.snapshot()).toThrow(PulumiEngineUnavailableError);
	});

	it("codes a missing CLI so a caller can fall back", () => {
		const created = createPulumiCliAutomationEngine({
			ephemeralState: true,
			workDir: tempDir(),
			pulumiBin: join(tempDir(), "not-installed"),
			env: { PATH: dirname(process.execPath) },
		});
		try {
			created.snapshot();
			expect.unreachable("expected the engine to refuse");
		} catch (error) {
			if (!(error instanceof PulumiEngineUnavailableError)) throw error;
			expect(error.code).toBe(PULUMI_CLI_MISSING);
		}
	});

	it("names the binary it could not run", () => {
		const missing = join(tempDir(), "not-installed");
		const created = createPulumiCliAutomationEngine({
			ephemeralState: true,
			workDir: tempDir(),
			pulumiBin: missing,
			env: { PATH: dirname(process.execPath) },
		});
		expect(() => created.snapshot()).toThrow(/not-installed/);
	});

	it("refuses a preview when the binary is missing", async () => {
		const created = createPulumiCliAutomationEngine({
			ephemeralState: true,
			workDir: tempDir(),
			pulumiBin: join(tempDir(), "not-installed"),
			env: { PATH: dirname(process.execPath) },
		});
		await expect(created.preview(program())).rejects.toThrow(
			PulumiEngineUnavailableError,
		);
	});

	it("accepts a CLI that answers the version probe", () => {
		expect(() => engine().snapshot()).not.toThrow();
	});

	it("verifies the CLI once rather than per operation", () => {
		const binDir = tempDir("hobo-pulumi-bin-");
		const bin = join(binDir, "pulumi");
		writeFileSync(
			bin,
			[
				"#!/usr/bin/env node",
				'process.stdout.write("v3.140.0\\n");',
				"process.exit(0);",
			].join("\n"),
			{ mode: 0o755 },
		);
		chmodSync(bin, 0o755);
		const created = createPulumiCliAutomationEngine({
			ephemeralState: true,
			workDir: tempDir("hobo-pulumi-work-"),
			pulumiBin: bin,
			env: { PATH: dirname(process.execPath) },
		});
		created.snapshot();
		rmSync(bin);
		expect(() => created.snapshot()).not.toThrow();
	});
});

describe("keeping state local", () => {
	it("refuses persistent state without a recoverable passphrase", async () => {
		const workDir = tempDir("hobo-pulumi-work-");
		const created = createPulumiCliAutomationEngine({
			workDir,
			pulumiBin: fakePulumi("process.exit(0);"),
			env: { PATH: dirname(process.execPath) },
		});
		await expect(created.preview(program())).rejects.toThrow(/passphrase/iu);
		expect(existsSync(join(workDir, "state"))).toBe(false);
	});

	it("passes the same supplied key to CLI engines restarted on one work directory", async () => {
		const workDir = tempDir("hobo-pulumi-work-");
		const log = join(tempDir("hobo-pulumi-log-"), "passphrase.log");
		const bin = fakePulumi(`
			require("node:fs").appendFileSync(${JSON.stringify(log)}, String(process.env.PULUMI_CONFIG_PASSPHRASE) + "\\n");
			if (argv[0] === "preview") process.stdout.write("{}");
			process.exit(0);
		`);
		for (let run = 0; run < 2; run++) {
			const created = createPulumiCliAutomationEngine({
				workDir,
				pulumiBin: bin,
				env: { PATH: dirname(process.execPath) },
				statePassphrase: "recoverable-test-passphrase",
			});
			await created.preview(program());
		}
		const seen = readFileSync(log, "utf8").trim().split("\n");
		expect(seen.length).toBeGreaterThanOrEqual(2);
		expect(new Set(seen)).toEqual(new Set(["recoverable-test-passphrase"]));
	});

	it("points the backend at its own work directory", async () => {
		const workDir = tempDir("hobo-pulumi-work-");
		const log = join(tempDir("hobo-pulumi-log-"), "env.log");
		const created = createPulumiCliAutomationEngine({
			ephemeralState: true,
			workDir,
			pulumiBin: fakePulumi(`
				require("node:fs").appendFileSync(
					${JSON.stringify(log)},
					String(process.env.PULUMI_BACKEND_URL) + "\\n",
				);
				if (argv[0] === "preview") { process.stdout.write("{}"); }
				process.exit(0);
			`),
			env: { PATH: dirname(process.execPath) },
		});
		await created.preview(program());
		expect(readFileSync(log, "utf8")).toContain(`file://${workDir}`);
	});

	it("never points the backend at a hosted organisation", async () => {
		const log = join(tempDir("hobo-pulumi-log-"), "env.log");
		const created = createPulumiCliAutomationEngine({
			ephemeralState: true,
			workDir: tempDir("hobo-pulumi-work-"),
			pulumiBin: fakePulumi(`
				require("node:fs").appendFileSync(
					${JSON.stringify(log)},
					String(process.env.PULUMI_BACKEND_URL) + "\\n",
				);
				if (argv[0] === "preview") { process.stdout.write("{}"); }
				process.exit(0);
			`),
			env: {
				PATH: dirname(process.execPath),
				PULUMI_BACKEND_URL: "https://api.pulumi.com",
			},
		});
		await created.preview(program());
		expect(readFileSync(log, "utf8")).not.toContain("api.pulumi.com");
	});

	it("reports an empty estate before anything is applied", () => {
		expect(engine().snapshot()).toEqual({});
	});

	it("freezes the snapshot", () => {
		expect(Object.isFrozen(engine().snapshot())).toBe(true);
	});
});

describe("previewing a program", () => {
	it("reports a change when the preview has one", async () => {
		const created = engine(`
			if (argv[0] === "preview") {
				process.stdout.write(JSON.stringify({ changeSummary: { create: 1 } }));
			}
			process.exit(0);
		`);
		expect((await created.preview(program())).changes).toHaveLength(1);
	});

	it("reports no change for an empty summary", async () => {
		const created = engine(`
			if (argv[0] === "preview") {
				process.stdout.write(JSON.stringify({ changeSummary: { same: 1 } }));
			}
			process.exit(0);
		`);
		expect((await created.preview(program())).changes).toEqual([]);
	});

	it("reports no change when there is no summary at all", async () => {
		const created = engine(`
			if (argv[0] === "preview") { process.stdout.write("{}"); }
			process.exit(0);
		`);
		expect((await created.preview(program())).changes).toEqual([]);
	});

	it("fails dirty when the preview cannot be parsed", async () => {
		const created = engine(`
			if (argv[0] === "preview") { process.stdout.write("not json"); }
			process.exit(0);
		`);
		expect((await created.preview(program())).changes).toHaveLength(1);
	});

	it("refuses a program whose type has no translation", async () => {
		await expect(engine().preview(program("aws:s3-bucket"))).rejects.toThrow(
			PulumiEngineUnavailableError,
		);
	});

	it("selects a stack before previewing it", async () => {
		const log = join(tempDir("hobo-pulumi-log-"), "calls.log");
		const created = engine(`
			require("node:fs").appendFileSync(${JSON.stringify(log)}, argv.join(" ") + "\\n");
			if (argv[0] === "preview") { process.stdout.write("{}"); }
			process.exit(0);
		`);
		await created.preview(program());
		const calls = readFileSync(log, "utf8");
		expect(calls).toContain("stack select");
	});

	it("creates the stack it selects", async () => {
		const log = join(tempDir("hobo-pulumi-log-"), "calls.log");
		const created = engine(`
			require("node:fs").appendFileSync(${JSON.stringify(log)}, argv.join(" ") + "\\n");
			if (argv[0] === "preview") { process.stdout.write("{}"); }
			process.exit(0);
		`);
		await created.preview(program());
		expect(readFileSync(log, "utf8")).toContain("--create");
	});
});
