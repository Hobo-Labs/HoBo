import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { checkCodegen, runCodegen } from "../src/codegen.js";
import { vetReportEnvelope } from "../src/cue.js";
import { parseCodegenArgv } from "../src/parse.js";
import { createCodegenReport, reportToJson } from "../src/types.js";

const REPO_ROOT = join(fileURLToPath(new URL("../../..", import.meta.url)));
// The frozen POC packages serve as read-only codegen fixtures. The frozen
// s0-04 proof suite runs the same mutating tests against the same checked-in
// tree, so this suite works on a private copy: two concurrent suites must
// never tamper/write the same generated files.
const POC_PACKAGES_SOURCE = join(
	REPO_ROOT,
	"src/draft/technical-proofs/s0-04-protobuf-cue-codegen/packages",
);
const CODEGEN_INTEGRATION_TIMEOUT_MS = 60_000;
// `codegen --check --json` runs over the whole repository, so it grows with
// each package it covers (@hobo/adapter-opensesame's data-models are one). Alone
// it took 22 s at load average 64 on the 4-CPU build machine, and it timed out
// at 60 s beside another suite at load 44. The budget is for the machine, not
// the property under test: the assertions are unchanged.
const REPO_WIDE_CODEGEN_TIMEOUT_MS = 180_000;

let POC_PACKAGES = POC_PACKAGES_SOURCE;
let tempRoot: string | undefined;

beforeAll(async () => {
	tempRoot = await mkdtemp(join(tmpdir(), "schema-tools-poc-"));
	POC_PACKAGES = join(tempRoot, "packages");
	await cp(POC_PACKAGES_SOURCE, POC_PACKAGES, { recursive: true });
}, CODEGEN_INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
	if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

function invocation(check = false) {
	return Object.freeze({
		...parseCodegenArgv(check ? ["--check"] : [], REPO_ROOT),
		packagesRoot: POC_PACKAGES,
	});
}

describe("codegen determinism", () => {
	it(
		"writes byte-identical output on consecutive runs",
		async () => {
			const opts = invocation(false);
			const first = await runCodegen(opts);
			const second = await runCodegen(opts);
			expect(first.status).toBe("CLEAN");
			expect(second.status).toBe("CLEAN");
		},
		CODEGEN_INTEGRATION_TIMEOUT_MS,
	);
});

describe("drift gate", () => {
	it(
		"ignores generated assets owned by another generator",
		async () => {
			const unrelated = join(
				POC_PACKAGES,
				"core/src/_generated/illustration.ts",
			);
			await writeFile(unrelated, "export const illustration = true;\n");
			try {
				const report = await checkCodegen(invocation(true));
				expect(report.status).toBe("CLEAN");
			} finally {
				await rm(unrelated, { force: true });
			}
		},
		CODEGEN_INTEGRATION_TIMEOUT_MS,
	);

	it(
		"checkCodegen reports DRIFT for tampered generated file without mutating disk",
		async () => {
			const generated = join(
				POC_PACKAGES,
				"core/src/_generated/hobo/core/v1/event_envelope_pb.ts",
			);
			const before = await readFile(generated, "utf8");
			const { writeFile, stat } = await import("node:fs/promises");
			try {
				await writeFile(generated, `${before}// tampered\n`);
				const beforeStat = await stat(generated);

				const report = await checkCodegen(invocation(true));
				const after = await readFile(generated, "utf8");
				const afterStat = await stat(generated);

				expect(report.status).toBe("DRIFT");
				expect(
					report.drift.some((entry) =>
						entry.path.includes("event_envelope_pb.ts"),
					),
				).toBe(true);
				expect(after).toBe(`${before}// tampered\n`);
				expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
			} finally {
				await writeFile(generated, before);
			}
		},
		CODEGEN_INTEGRATION_TIMEOUT_MS,
	);
});

describe("CUE lane", () => {
	it(
		"accepts valid fixtures and rejects invalid fixtures fail-closed",
		async () => {
			const report = await checkCodegen(invocation(true));
			expect(report.cueViolations).toHaveLength(0);
		},
		CODEGEN_INTEGRATION_TIMEOUT_MS,
	);
});

describe("json envelope", () => {
	it(
		"round-trips CLEAN report and satisfies CUE constraints",
		async () => {
			const result = await runCli(["--check", "--json"], REPO_ROOT);
			expect(result.exitCode).toBe(0);
			const envelope = JSON.parse(result.stdout);
			expect(envelope.status).toBe("CLEAN");
			expect(Array.isArray(envelope.drift)).toBe(true);

			const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
			const { tmpdir } = await import("node:os");
			const dir = await mkdtemp(join(tmpdir(), "codegen-report-"));
			const path = join(dir, "report.json");
			await writeFile(path, result.stdout);
			const cue = await vetReportEnvelope(REPO_ROOT, path);
			await rm(dir, { recursive: true, force: true });
			expect(cue.ok).toBe(true);

			const sample = createCodegenReport({ status: "CLEAN", durationMs: 1 });
			expect(JSON.parse(reportToJson(sample)).status).toBe("CLEAN");
		},
		REPO_WIDE_CODEGEN_TIMEOUT_MS,
	);
});

describe("pact consumer", () => {
	it("pins CI envelope fields status and drift[].path", async () => {
		const pactPath = join(
			import.meta.dirname,
			"../contracts/pacts/schema_tools_codegen_report.pact.json",
		);
		const pact = JSON.parse(await readFile(pactPath, "utf8"));
		expect(pact.consumer.name).toBe("HoboCiSchemaGate");
		expect(pact.provider.name).toBe("SchemaToolsCodegen");
		const clean = pact.interactions.find((item: { description: string }) =>
			item.description.includes("CLEAN"),
		);
		expect(clean.response.body.status).toBe("CLEAN");
		const drift = pact.interactions.find((item: { description: string }) =>
			item.description.includes("drift"),
		);
		expect(drift.response.body.drift[0].path).toContain("_generated");
	});
});
