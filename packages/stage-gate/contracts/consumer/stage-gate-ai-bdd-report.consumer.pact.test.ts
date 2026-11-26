/**
 * Consumer side of the ai-bdd process boundary (ADR-0172). Each interaction of
 * stage-gate-ai-bdd-report.pact.json is one ai-bdd command and how it ends
 * (exit code, whether a report is written, the report). The test plays each
 * one back through the stand-in ai-bdd (test/helpers/fake-ai-bdd.mts) and
 * runs the gate step that issues that command, in process, so the assertion
 * is about how the gate reads the provider, not about the pact's own text.
 */
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
	type AcceptanceStep,
	checkAcceptance,
} from "../../src/acceptance-check.js";
import {
	isJsonArray,
	isJsonInteger,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonText,
} from "../../src/json.js";
import { fixtureBytes } from "../../test/helpers/ai-bdd-report.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "..", "..", "test", "helpers", "fake-ai-bdd.mts");
const PACT = join(HERE, "..", "pacts", "stage-gate-ai-bdd-report.pact.json");

interface Interaction {
	readonly description: string;
	readonly path: string;
	readonly status: number;
	readonly exitCode: number;
	readonly report: JsonObject | undefined;
	/** The `Run: <dir>` line a run that wrote a report prints on stdout, naming that run. */
	readonly stdoutRunLine: string | undefined;
}

function objectAt(node: JsonValue | undefined, what: string): JsonObject {
	if (!isJsonObject(node)) throw new Error(`pact: ${what} is not an object`);
	return node;
}

function interactions(): Interaction[] {
	const pact = objectAt(parseJsonText(readFileSync(PACT, "utf8")), "pact");
	expect(objectAt(pact.consumer, "consumer").name).toBe("@hobo/stage-gate");
	expect(objectAt(pact.provider, "provider").name).toBe("ai-bdd");
	const list = isJsonArray(pact.interactions) ? pact.interactions : [];
	return list.map((raw, index) => {
		const entry = objectAt(raw, `interactions[${index}]`);
		const response = objectAt(entry.response, "response");
		const body = objectAt(response.body, "response.body");
		const exitCode = body.exitCode;
		if (!isJsonInteger(exitCode) || !isJsonInteger(response.status)) {
			throw new Error(`pact: interactions[${index}] has no exit code`);
		}
		return {
			description: String(entry.description),
			path: String(objectAt(entry.request, "request").path),
			status: response.status,
			exitCode,
			report: isJsonObject(body.report) ? body.report : undefined,
			stdoutRunLine: isJsonString(body.stdoutRunLine)
				? body.stdoutRunLine
				: undefined,
		};
	});
}

const STEP_OF_PATH = new Map<string, AcceptanceStep>([
	["/compile", "plans-fresh"],
	["/run", "replay"],
	["/verify-run", "evidence-intact"],
]);

interface GateReading {
	readonly outcome: string;
	readonly exit: number;
}

/** How the gate must read each exit code of each command (ADR-0172). */
const EXPECTED = new Map<string, GateReading>([
	["plans-fresh 0", { outcome: "passed", exit: 0 }],
	["plans-fresh 4", { outcome: "failed", exit: 4 }],
	["replay 0", { outcome: "passed", exit: 0 }],
	["replay 1", { outcome: "failed", exit: 1 }],
	["replay 2", { outcome: "failed", exit: 2 }],
	["replay 3", { outcome: "not_run", exit: 3 }],
	["replay 4", { outcome: "failed", exit: 4 }],
	["evidence-intact 0", { outcome: "passed", exit: 0 }],
	["evidence-intact 1", { outcome: "failed", exit: 1 }],
]);

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function newDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-ai-bdd-pact-"));
	dirs.push(dir);
	return dir;
}

/** The paths of every leaf in a JSON value, arrays written `[]`. */
function leafPaths(node: JsonValue, prefix: string): string[] {
	if (isJsonArray(node))
		return node.flatMap((entry) => leafPaths(entry, `${prefix}[]`));
	if (!isJsonObject(node)) return [prefix];
	return Object.entries(node).flatMap(([key, value]) =>
		leafPaths(value, prefix === "" ? key : `${prefix}.${key}`),
	);
}

/**
 * The report ai-bdd writes for an interaction: a real report (the passed
 * fixture) with the fields the pact states laid over it. Objects merge key by
 * key and arrays entry by entry, so the pact names what the gate reads and the
 * fixture supplies every other field RunReport v1 requires.
 */
function overlay(base: JsonValue, over: JsonValue): JsonValue {
	if (isJsonArray(base) && isJsonArray(over)) {
		if (over.length > base.length) {
			throw new Error("pact: an array longer than the fixture's");
		}
		return base.map((entry, index) => {
			const laid = over[index];
			return laid === undefined ? entry : overlay(entry, laid);
		});
	}
	if (isJsonObject(base) && isJsonObject(over)) {
		const merged = new Map<string, JsonValue>(Object.entries(base));
		for (const [key, value] of Object.entries(over)) {
			const under = merged.get(key);
			merged.set(key, under === undefined ? value : overlay(under, value));
		}
		return Object.fromEntries(merged);
	}
	return over;
}

function writtenReport(report: JsonObject): string {
	const real = parseJsonText(
		fixtureBytes("report.v1.passed.json").toString("utf8"),
	);
	if (real === undefined) throw new Error("fixture is not JSON");
	return `${JSON.stringify(overlay(real, report), null, 2)}\n`;
}

describe("ai-bdd report consumer pact", () => {
	const all = interactions();

	it("covers every exit code of run, and both outcomes of compile --check and verify-run", () => {
		const covered = all.map((i) => `${STEP_OF_PATH.get(i.path)} ${i.exitCode}`);
		expect(covered.sort()).toEqual([...EXPECTED.keys()].sort());
	});

	it("names the run of every report written in a Run: line, as the gate requires", () => {
		const runs = all.filter((i) => i.path === "/run");
		expect(
			runs.map((i) => [i.exitCode, i.stdoutRunLine !== undefined]),
		).toEqual(runs.map((i) => [i.exitCode, i.report !== undefined]));
		for (const run of runs) {
			if (run.report === undefined) continue;
			expect(run.stdoutRunLine).toBe(`Run: .ai-bdd/runs/${run.report.runId}`);
		}
	});

	it.each(all.map((i) => [i.description, i]))(
		"%s",
		async (_description, interaction) => {
			const step = STEP_OF_PATH.get(interaction.path);
			if (step === undefined)
				throw new Error(`pact: unknown path ${interaction.path}`);
			const project = newDir();
			let reportFile: string | undefined;
			if (interaction.report !== undefined) {
				reportFile = join(newDir(), "report.json");
				writeFileSync(reportFile, writtenReport(interaction.report));
			}
			let handed = "";
			if (step === "evidence-intact") {
				// verify-run checks the run acceptance-replay judged, which the runner hands over: put that run in place.
				const runDir = join(
					project,
					".ai-bdd",
					"runs",
					"01a132d2-fe9a-7d3a-a7d8-157d681d6417",
				);
				mkdirSync(join(project, ".ai-bdd", "report"), { recursive: true });
				mkdirSync(runDir, { recursive: true });
				const passed = all.find(
					(i) => i.path === "/run" && i.exitCode === 0,
				)?.report;
				if (passed === undefined) throw new Error("pact: no passing run");
				const bytes = writtenReport(passed);
				writeFileSync(join(project, ".ai-bdd", "report", "report.json"), bytes);
				writeFileSync(join(runDir, "report.json"), bytes);
				handed = JSON.stringify({
					"acceptance-replay": {
						run_id: "01a132d2-fe9a-7d3a-a7d8-157d681d6417",
						report_digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
					},
				});
			}
			if (interaction.report === undefined && step === "replay") {
				// An earlier run's report is on disk; after exit 2 or 4 it must not be read.
				mkdirSync(join(project, ".ai-bdd", "report"), { recursive: true });
				writeFileSync(
					join(project, ".ai-bdd", "report", "report.json"),
					fixtureBytes("report.v1.passed.json"),
				);
			}
			const plan = {
				compileCheck: interaction.exitCode,
				run: {
					exit: interaction.exitCode,
					report: reportFile,
					// The stand-in prints its own run's directory, as ai-bdd does; none when the pact names none.
					printedRun:
						interaction.stdoutRunLine === undefined ? "none" : undefined,
				},
				verifyRun: interaction.exitCode,
			};
			const result = await checkAcceptance(
				[step],
				{
					...process.env,
					HOBO_AI_BDD_CMD: JSON.stringify([
						process.execPath,
						"--experimental-strip-types",
						"--no-warnings",
						FAKE,
					]),
					HOBO_AI_BDD_PROJECT: project,
					FAKE_AI_BDD: JSON.stringify(plan),
					FAKE_AI_BDD_LOG: join(newDir(), "calls.log"),
					HOBO_STAGE_GATE_REQUIRED_EVIDENCE: handed,
				},
				project,
			);
			const expected = EXPECTED.get(`${step} ${interaction.exitCode}`);
			expect({ outcome: result.outcome, exit: result.exitCode }).toEqual(
				expected,
			);
			const readsReport =
				step === "replay" &&
				(interaction.exitCode === 0 || interaction.exitCode === 1);
			if (readsReport && reportFile !== undefined) {
				// The stand-in writes the report as a run would: a run id of its own, started now.
				const written = join(project, ".ai-bdd", "report", "report.json");
				const digest = createHash("sha256")
					.update(readFileSync(written))
					.digest("hex");
				expect(result.evidence.report_digest).toBe(`sha256:${digest}`);
			} else {
				expect(result.evidence.scenarios_total).toBeUndefined();
			}
		},
		30_000,
	);

	it("asks nothing of a report that ai-bdd's real reports do not carry", () => {
		const real = parseJsonText(
			fixtureBytes("report.v1.passed.json").toString("utf8"),
		);
		if (real === undefined) throw new Error("fixture is not JSON");
		const provided = new Set(leafPaths(real, ""));
		for (const interaction of all) {
			if (interaction.report === undefined) continue;
			for (const path of leafPaths(interaction.report, "")) {
				// An empty array in the pact is a leaf; the real report has entries there.
				expect(
					provided.has(path) ||
						[...provided].some((p) => p.startsWith(`${path}[]`)),
					`${interaction.description}: ${path}`,
				).toBe(true);
			}
		}
	});
});
