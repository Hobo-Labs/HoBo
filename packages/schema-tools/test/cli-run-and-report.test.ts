/**
 * The schema-tools CLI's outer shell: argv → report → exit code.
 *
 * This is what CI actually invokes, so its contract is the exit code and the
 * shape of what it prints — not the codegen underneath.
 *
 * **A failure must not be reported as clean.** The whole point of the check
 * lane is to fail a build when generated code has drifted from its schema. An
 * exception anywhere inside — a missing CUE toolchain, an unreadable package —
 * has to surface as a non-zero exit, never as a silent pass.
 *
 * **`--json` must stay parseable on the failure path too.** A caller that
 * asked for JSON is a program. Handing it a bare error line on stderr means it
 * either crashes on `JSON.parse` or, worse, sees empty stdout and reads that
 * as "no violations".
 *
 * **The human rendering names every drift and every violation.** A summary
 * that said only "DRIFT" would leave the developer to re-run the tool with
 * different flags to find out what actually moved.
 *
 * The CUE toolchain is supplied as a stand-in on PATH — `ensureCueBinary`
 * checks PATH first, so a script answering the version probe is
 * indistinguishable from the real thing to everything downstream.
 */
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

/** Put a stand-in `cue` on PATH that answers the version probe. */
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
	// The stand-in is a node script, so its shebang needs node's own directory.
	process.env.PATH = `${dir}:${dirname(process.execPath)}`;
}

/**
 * A repo root the CLI will accept: a buf template at the root, and one package
 * that has opted into codegen by giving its `data-models` a `buf.yaml` marker.
 * A bare `.proto`/`.cue` folder without that marker is documentation-only.
 */
function repo(options: { withPackage?: boolean; withTemplate?: boolean } = {}) {
	const root = tempDir("hobo-schema-repo-");
	mkdirSync(join(root, "packages"), { recursive: true });
	if (options.withTemplate !== false) {
		// `preflightBuf` requires the template before it will run — a repo
		// without one cannot generate anything, and saying so up front is
		// clearer than failing inside buf later.
		writeFileSync(join(root, "buf.gen.yaml"), "version: v2\nplugins: []\n");
	}
	if (options.withPackage !== false) {
		const dataModels = join(root, "packages", "orders", "data-models");
		mkdirSync(dataModels, { recursive: true });
		writeFileSync(join(dataModels, "buf.yaml"), "version: v2\n");
		// buf refuses a module with no .proto files, so an opted-in package
		// needs at least one for the run to reach codegen at all.
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

/** The accepting fixture, for the tests that drive a successful run. */
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
		// The duration is what tells a developer whether codegen is the slow part
		// of their build; omitting it hides a regression they could act on.
		expect((await runCli([], emptyRepo())).stdout).toContain("durationMs:");
	});

	it("exits zero in check mode too", async () => {
		fakeCueOnPath();
		expect((await runCli(["--check"], emptyRepo())).exitCode).toBe(0);
	});

	it("renders JSON when asked", async () => {
		fakeCueOnPath();
		const result = await runCli(["--json"], emptyRepo());
		// A `--json` caller is a program; it must get something parseable.
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
		// Absent arrays and empty arrays are different to a consumer: one is
		// "nothing found", the other is "the tool did not look".
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
		// The whole point of the check lane is to fail a build. A missing
		// toolchain reported as CLEAN would let drifted code merge.
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
		// A caller that asked for JSON and got a bare stderr line either crashes
		// on JSON.parse or sees empty stdout and reads it as "no violations".
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
		// Naming the stage is what tells a developer whether to install a
		// toolchain or to look at their schemas.
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
		// Splitting the failure across both streams would make a caller merge
		// them to understand what happened.
		expect((await runCli(["--json"], emptyRepo())).stderr).toBe("");
	});
});

describe("a repo with nothing to generate is refused", () => {
	it("refuses a packages tree with no data-model packages", async () => {
		fakeCueOnPath();
		// A repo where nothing opted into codegen is a misconfiguration, not a
		// clean run. Reporting CLEAN would let a mis-scoped CI job pass while
		// generating nothing.
		const result = await runCli([], repo({ withPackage: false }));
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("no data-model packages found");
	});

	it("names the root it searched", async () => {
		fakeCueOnPath();
		// A developer whose packages live somewhere else needs to see where the
		// tool actually looked.
		expect((await runCli([], repo({ withPackage: false }))).stderr).toContain(
			"packages",
		);
	});

	it("ignores a data-models folder with no buf.yaml marker", async () => {
		fakeCueOnPath();
		const root = repo({ withPackage: false });
		// Proto and CUE files without the marker are documentation. Generating
		// from them would produce code nobody asked for.
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
		// A repo with no template cannot generate anything. Saying so up front
		// is clearer than failing inside buf with a plugin error.
		const result = await runCli([], repo({ withTemplate: false }));
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("buf template missing");
	});

	it("names the path it looked for", async () => {
		fakeCueOnPath();
		// Without the path, a developer with a template in the wrong place
		// cannot tell where it was expected.
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
		// `--filter --json` is a typo for `--filter x --json`; consuming the flag
		// as the value would filter to a package named "--json" and report
		// CLEAN because nothing matched.
		const result = await runCli(["--filter", "--json"], emptyRepo());
		expect(result.exitCode).toBe(1);
	});

	it("reports an argument error before running any codegen", async () => {
		// No `cue` on PATH at all: the argv error has to surface first, or the
		// developer is told to install a toolchain they do not need yet.
		process.env.PATH = dirname(process.execPath);
		const result = await runCli(["--filter"], emptyRepo());
		expect(result.stderr).toContain("--filter");
	});

	it("accepts a --filter that names a directory", async () => {
		fakeCueOnPath();
		const root = emptyRepo();
		const result = await runCli(["--filter", "packages"], root);
		// A filter matching nothing is not an error — it is an empty run.
		expect(result.exitCode).toBe(0);
	});
});

describe("surfacing what actually failed", () => {
	it("names the offending proto when buf refuses one", async () => {
		fakeCueOnPath();
		const root = repo();
		// A syntax error in one file out of many: the message has to name it, or
		// the developer re-runs buf by hand to find out which.
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
		// The stand-in cue fails every vet, which is what a real constraint
		// violation looks like from here.
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
		// A CUE violation is an ERROR, not DRIFT: the schema and its fixtures
		// disagree, so regenerating would not fix anything.
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
		// A repo-wide report interleaves packages; an unattributed violation
		// cannot be routed to whoever owns the schema.
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
		// A flat scan would silently skip every schema in a subdirectory, and the
		// run would report CLEAN having generated nothing for them.
		expect((await runCli([], root)).exitCode).toBe(0);
	});
});

describe("vetting the codegen report envelope", () => {
	/**
	 * The report this tool emits is itself CUE-constrained. That is what stops a
	 * schema-checking tool from emitting a report no downstream consumer can
	 * parse — the checker gets checked.
	 */
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
		// The report envelope is schema-tools' own contract, so a violation in it
		// belongs to schema-tools rather than to whichever package was being
		// generated when it happened.
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
