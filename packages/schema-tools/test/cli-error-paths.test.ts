import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import {
	FIXTURE_WORKSPACE,
	makeTempRepo,
	removeTempRepo,
} from "./support/temp-workspace.js";

const INTEGRATION_TIMEOUT_MS = 60_000;

describe("argv errors", () => {
	it("fails with exit 1 and a stderr message for unknown flags", async () => {
		const result = await runCli(["--frobnicate"]);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("unknown flag: --frobnicate");
	});

	it("reports argv errors on stderr even when --json was requested", async () => {
		// Parsing throws before the invocation exists, so the json error
		// envelope cannot apply yet — pinned so the contract stays deliberate.
		const result = await runCli(["--json", "--frobnicate"]);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("unknown flag: --frobnicate");
	});
});

describe("preflight errors", () => {
	it(
		"fails when the buf template is missing from the repo root",
		async () => {
			const root = await makeTempRepo({
				withBufTemplate: false,
				workspace: FIXTURE_WORKSPACE,
			});
			try {
				const result = await runCli(["--check"], root);
				expect(result.exitCode).toBe(1);
				expect(result.stderr).toContain("buf template missing");
			} finally {
				await removeTempRepo(root);
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"wraps preflight failures in the json error envelope under --json",
		async () => {
			const root = await makeTempRepo({
				withBufTemplate: false,
				workspace: FIXTURE_WORKSPACE,
			});
			try {
				const result = await runCli(["--check", "--json"], root);
				expect(result.exitCode).toBe(1);
				expect(result.stderr).toBe("");
				const envelope = JSON.parse(result.stdout);
				expect(envelope.status).toBe("ERROR");
				expect(envelope.drift).toEqual([]);
				expect(envelope.cueViolations).toEqual([
					{
						package: "schema-tools",
						constraint: "preflight",
						message: expect.stringContaining("buf template missing"),
					},
				]);
				expect(envelope.durationMs).toBe(0);
			} finally {
				await removeTempRepo(root);
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);
});

describe("pipeline errors", () => {
	it(
		"fails when no data-model package opts into codegen",
		async () => {
			const root = await makeTempRepo();
			try {
				const result = await runCli(["--check", "--json"], root);
				expect(result.exitCode).toBe(1);
				const envelope = JSON.parse(result.stdout);
				expect(envelope.status).toBe("ERROR");
				expect(envelope.cueViolations[0].message).toContain(
					"no data-model packages found under",
				);
			} finally {
				await removeTempRepo(root);
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"surfaces a malformed buf.yaml as an ERROR envelope",
		async () => {
			const root = await makeTempRepo({ workspace: FIXTURE_WORKSPACE });
			try {
				const bufYaml = join(
					root,
					"packages",
					"widgets",
					"data-models",
					"buf.yaml",
				);
				await writeFile(bufYaml, "{{{{ not yaml\n");
				const result = await runCli(["--check", "--json"], root);
				expect(result.exitCode).toBe(1);
				const envelope = JSON.parse(result.stdout);
				expect(envelope.status).toBe("ERROR");
				expect(envelope.cueViolations[0].message.length).toBeGreaterThan(0);
			} finally {
				await removeTempRepo(root);
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"names the offending file when a proto references a missing import",
		async () => {
			const root = await makeTempRepo({ workspace: FIXTURE_WORKSPACE });
			try {
				const proto = join(
					root,
					"packages",
					"widgets",
					"data-models",
					"widget.proto",
				);
				const before = await readFile(proto, "utf8");
				await writeFile(
					proto,
					before.replace(
						"package hobo.widgets.v1;",
						'package hobo.widgets.v1;\n\nimport "does_not_exist.proto";',
					),
				);
				const result = await runCli(["--check", "--json"], root);
				expect(result.exitCode).toBe(1);
				const envelope = JSON.parse(result.stdout);
				expect(envelope.status).toBe("ERROR");
				expect(envelope.cueViolations[0].message).toContain(".proto");
			} finally {
				await removeTempRepo(root);
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);
});
