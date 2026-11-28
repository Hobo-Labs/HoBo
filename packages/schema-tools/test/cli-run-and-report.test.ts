import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";
import { vetReportEnvelope } from "../src/cue.js";

const dirs: string[] = [];
const originalPath = process.env.PATH;

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockRejectedValue(new Error("offline test fixture")),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	process.env.PATH = originalPath;
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "hobo-schema-cli-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function fakeCueOnPath(body = "process.exit(0);"): void {
	const dir = tempDir("hobo-schema-cue-");
	const bin = join(dir, "cue");
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const argv = process.argv.slice(2);",
			'if (argv[0] === "version") { process.stdout.write("cue version v0.14.0\\n"); process.exit(0); }',
			body,
		].join("\n"),
		{ mode: 0o755 },
	);
	chmodSync(bin, 0o755);
	process.env.PATH = `${dir}:${dirname(process.execPath)}`;
}

function repo(options: { withPackage?: boolean; withTemplate?: boolean } = {}) {
	const root = tempDir("hobo-schema-repo-");
	mkdirSync(join(root, "packages"), { recursive: true });
	if (options.withTemplate !== false) {
		writeFileSync(join(root, "buf.gen.yaml"), "version: v2\nplugins: []\n");
	}
	if (options.withPackage !== false) {
		const dataModels = join(root, "packages", "orders", "data-models");
		mkdirSync(dataModels, { recursive: true });
		writeFileSync(join(dataModels, "buf.yaml"), "version: v2\n");
		writeFileSync(
			join(dataModels, "order.proto"),
			[
				'syntax = "proto3";',
				"package hobo.orders.v1;",
				"message OrderLine { string sku = 1; }",
				"",
			].join("\n"),
		);
	}
	return root;
}

const emptyRepo = () => repo();

describe("running the CLI over a repo with nothing to generate", () => {
	it("exits zero", async () => {
		fakeCueOnPath();
		expect((await runCli([], emptyRepo())).exitCode).toBe(0);
	});

	it("reports a clean status", async () => {
		fakeCueOnPath();
		expect((await runCli([], emptyRepo())).stdout).toContain("status: CLEAN");
	});

	it("writes nothing to stderr on success", async () => {
		fakeCueOnPath();
		expect((await runCli([], emptyRepo())).stderr).toBe("");
	});

	it("reports a duration", async () => {
		fakeCueOnPath();
		expect((await runCli([], emptyRepo())).stdout).toContain("durationMs:");
	});

	it("exits zero in check mode too", async () => {
		fakeCueOnPath();
		expect((await runCli(["--check"], emptyRepo())).exitCode).toBe(0);
	});

	it("renders JSON when asked", async () => {
		fakeCueOnPath();
		const result = await runCli(["--json"], emptyRepo());
		expect(() => JSON.parse(result.stdout)).not.toThrow();
	});

	it("reports the status inside the JSON body", async () => {
		fakeCueOnPath();
		const result = await runCli(["--json"], emptyRepo());
		expect(JSON.parse(result.stdout)).toMatchObject({ status: "CLEAN" });
	});

	it("carries empty drift and violation lists in JSON", async () => {
		fakeCueOnPath();
		const parsed = JSON.parse((await runCli(["--json"], emptyRepo())).stdout);
		expect(parsed).toMatchObject({ drift: [], cueViolations: [] });
	});

	it("accepts --check and --json together", async () => {
		fakeCueOnPath();
		const result = await runCli(["--check", "--json"], emptyRepo());
		expect(result.exitCode).toBe(0);
		expect(() => JSON.parse(result.stdout)).not.toThrow();
	});
});

describe("failing without a CUE toolchain", () => {
	it("exits non-zero rather than reporting clean", async () => {
		process.env.PATH = dirname(process.execPath);
		expect((await runCli(["--check"], emptyRepo())).exitCode).toBe(1);
	});

	it("explains itself on stderr in human mode", async () => {
		process.env.PATH = dirname(process.execPath);
		const result = await runCli(["--check"], emptyRepo());
		expect(result.stderr.length).toBeGreaterThan(0);
		expect(result.stdout).toBe("");
	});

	it("stays parseable JSON on the failure path", async () => {
		process.env.PATH = dirname(process.execPath);
		const result = await runCli(["--check", "--json"], emptyRepo());
		expect(() => JSON.parse(result.stdout)).not.toThrow();
	});

	it("reports ERROR status in the JSON failure body", async () => {
		process.env.PATH = dirname(process.execPath);
		const parsed = JSON.parse((await runCli(["--json"], emptyRepo())).stdout);
		expect(parsed.status).toBe("ERROR");
	});

	it("attributes the failure to the preflight", async () => {
		process.env.PATH = dirname(process.execPath);
		const parsed = JSON.parse((await runCli(["--json"], emptyRepo())).stdout);
		expect(parsed.cueViolations[0]).toMatchObject({
			package: "schema-tools",
			constraint: "preflight",
		});
	});

	it("carries the underlying message into the JSON violation", async () => {
		process.env.PATH = dirname(process.execPath);
		const parsed = JSON.parse((await runCli(["--json"], emptyRepo())).stdout);
		expect(String(parsed.cueViolations[0].message).length).toBeGreaterThan(0);
	});

	it("writes nothing to stderr when JSON was requested", async () => {
		process.env.PATH = dirname(process.execPath);
		expect((await runCli(["--json"], emptyRepo())).stderr).toBe("");
	});
});

describe("a repo with nothing to generate is refused", () => {
	it("refuses a packages tree with no data-model packages", async () => {
		fakeCueOnPath();
		const result = await runCli([], repo({ withPackage: false }));
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("no data-model packages found");
	});

	it("names the root it searched", async () => {
		fakeCueOnPath();
		expect((await runCli([], repo({ withPackage: false }))).stderr).toContain(
			"packages",
		);
	});

	it("ignores a data-models folder with no buf.yaml marker", async () => {
		fakeCueOnPath();
		const root = repo({ withPackage: false });
		mkdirSync(join(root, "packages", "docs-only", "data-models"), {
			recursive: true,
		});
		writeFileSync(
			join(root, "packages", "docs-only", "data-models", "note.proto"),
			'syntax = "proto3";\n',
		);
		expect((await runCli([], root)).exitCode).toBe(1);
	});
});

describe("the buf preflight", () => {
	it("refuses a repo with no buf template", async () => {
		fakeCueOnPath();
		const result = await runCli([], repo({ withTemplate: false }));
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("buf template missing");
	});

	it("names the path it looked for", async () => {
		fakeCueOnPath();
		expect((await runCli([], repo({ withTemplate: false }))).stderr).toContain(
			"buf.gen.yaml",
		);
	});
});

describe("argument errors", () => {
	it("refuses --filter with no value", async () => {
		fakeCueOnPath();
		const result = await runCli(["--filter"], emptyRepo());
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("--filter");
	});

	it("refuses --filter followed by another flag", async () => {
		fakeCueOnPath();
		const result = await runCli(["--filter", "--json"], emptyRepo());
		expect(result.exitCode).toBe(1);
	});

	it("reports an argument error before running any codegen", async () => {
		process.env.PATH = dirname(process.execPath);
		const result = await runCli(["--filter"], emptyRepo());
		expect(result.stderr).toContain("--filter");
	});

	it("accepts a --filter that names a directory", async () => {
		fakeCueOnPath();
		const root = emptyRepo();
		const result = await runCli(["--filter", "packages"], root);
		expect(result.exitCode).toBe(0);
	});
});

describe("surfacing what actually failed", () => {
	it("names the offending proto when buf refuses one", async () => {
		fakeCueOnPath();
		const root = repo();
		writeFileSync(
			join(root, "packages", "orders", "data-models", "broken.proto"),
			'syntax = "proto3";\npackage hobo.orders.v1;\nmessage { }\n',
		);
		const result = await runCli([], root);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("broken.proto");
	});

	it("keeps a buf failure parseable under --json", async () => {
		fakeCueOnPath();
		const root = repo();
		writeFileSync(
			join(root, "packages", "orders", "data-models", "broken.proto"),
			'syntax = "proto3";\nmessage { }\n',
		);
		const result = await runCli(["--json"], root);
		expect(() => JSON.parse(result.stdout)).not.toThrow();
		expect(JSON.parse(result.stdout).status).toBe("ERROR");
	});

	it("reports ERROR when a CUE constraint is violated", async () => {
		fakeCueOnPath(
			"process.stderr.write('qty: incomplete value'); process.exit(1);",
		);
		const root = repo();
		const dataModels = join(root, "packages", "orders", "data-models");
		writeFileSync(
			join(dataModels, "order_line.cue"),
			"#OrderLine: { qty: int }\n",
		);
		mkdirSync(join(dataModels, "fixtures", "valid"), { recursive: true });
		writeFileSync(join(dataModels, "fixtures", "valid", "good.json"), "{}\n");
		const result = await runCli([], root);
		expect(result.exitCode).toBe(1);
		expect(result.stdout + result.stderr).toContain("cue");
	});

	it("names the violating package and constraint", async () => {
		fakeCueOnPath("process.exit(1);");
		const root = repo();
		const dataModels = join(root, "packages", "orders", "data-models");
		writeFileSync(
			join(dataModels, "order_line.cue"),
			"#OrderLine: { qty: int }\n",
		);
		mkdirSync(join(dataModels, "fixtures", "valid"), { recursive: true });
		writeFileSync(join(dataModels, "fixtures", "valid", "good.json"), "{}\n");
		const parsed = JSON.parse((await runCli(["--json"], root)).stdout);
		expect(parsed.cueViolations[0]).toMatchObject({
			package: "orders",
			constraint: "order_line.cue",
		});
	});

	it("walks nested proto directories", async () => {
		fakeCueOnPath();
		const root = repo();
		const nested = join(root, "packages", "orders", "data-models", "v2");
		mkdirSync(nested, { recursive: true });
		writeFileSync(
			join(nested, "shipment.proto"),
			'syntax = "proto3";\npackage hobo.orders.v2;\nmessage Shipment { string id = 1; }\n',
		);
		expect((await runCli([], root)).exitCode).toBe(0);
	});
});

describe("vetting the codegen report envelope", () => {
	it("accepts a report the constraint admits", async () => {
		fakeCueOnPath();
		const root = tempDir("hobo-schema-report-");
		const reportPath = join(root, "report.json");
		writeFileSync(
			reportPath,
			JSON.stringify({
				status: "CLEAN",
				drift: [],
				cueViolations: [],
				durationMs: 1,
			}),
		);
		expect(await vetReportEnvelope(root, reportPath)).toEqual({
			ok: true,
			violations: [],
		});
	});

	it("reports a violation when the constraint refuses", async () => {
		fakeCueOnPath(
			"process.stderr.write('status: 2 errors in empty disjunction'); process.exit(1);",
		);
		const root = tempDir("hobo-schema-report-");
		const reportPath = join(root, "report.json");
		writeFileSync(reportPath, JSON.stringify({ status: "NONSENSE" }));
		const result = await vetReportEnvelope(root, reportPath);
		expect(result.ok).toBe(false);
	});

	it("attributes the violation to its own schema", async () => {
		fakeCueOnPath("process.exit(1);");
		const root = tempDir("hobo-schema-report-");
		const reportPath = join(root, "report.json");
		writeFileSync(reportPath, "{}");
		const result = await vetReportEnvelope(root, reportPath);
		expect(result.violations[0]).toMatchObject({
			package: "schema-tools",
			constraint: "codegen_report.cue",
		});
	});

	it("carries CUE's explanation into the violation", async () => {
		fakeCueOnPath(
			"process.stderr.write('durationMs: incomplete value int'); process.exit(1);",
		);
		const root = tempDir("hobo-schema-report-");
		const reportPath = join(root, "report.json");
		writeFileSync(reportPath, "{}");
		const result = await vetReportEnvelope(root, reportPath);
		expect(result.violations[0]?.message).toContain("incomplete value int");
	});

	it("falls back to stdout when CUE said nothing on stderr", async () => {
		fakeCueOnPath(
			"process.stdout.write('conflicting values'); process.exit(1);",
		);
		const root = tempDir("hobo-schema-report-");
		const reportPath = join(root, "report.json");
		writeFileSync(reportPath, "{}");
		const result = await vetReportEnvelope(root, reportPath);
		expect(result.violations[0]?.message).toContain("conflicting values");
	});
});
