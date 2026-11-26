import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	createAdapterRegistry,
	createConformanceSuite,
	evaluateSdkParity,
	replayPortSuiteReport,
	runConformanceSuite,
} from "../src/index.ts";
import {
	goldenAndTraceDriftAdapter,
	languageLeakAdapter,
	missingFunctionAdapter,
	nondeterministicAdapter,
	subtractOutputAdapter,
	throwingAdapter,
	traceDriftAdapter,
} from "./mutated-adapter.ts";
import { passingToyAdapter, toySuite } from "./reference-adapter.ts";

describe("conformance port-suite harness", () => {
	it("reference adapter passes with listed claim and full assertions", async () => {
		const passReport = await runConformanceSuite(
			toySuite(),
			passingToyAdapter,
			{
				seed: "hobo-5-stable-seed",
			},
		);

		expect(passReport.ok).toBe(true);
		expect(passReport.provenance).toEqual({
			suiteId: "toy-math-port",
			port: "hobo:toy-math@0.1.0",
			adapterId: "toy-adapter-good",
			seed: "hobo-5-stable-seed",
			cases: ["adds-two-numbers"],
		});
		expect(passReport.claim).toEqual({
			status: "listed",
			port: "hobo:toy-math@0.1.0",
			adapterId: "toy-adapter-good",
			failureCodes: [],
		});
		expect(passReport.coverage).toEqual({
			exercisedFunctions: ["add"],
			requiredFunctions: ["add"],
			unexercisedFunctions: [],
		});
		expect(passReport.assertions.map((assertion) => assertion.code)).toEqual([
			"adapter.output",
			"golden-ir.equivalence",
			"trace-replay.equivalence",
		]);
	});

	it("subtract mutant fails with precise output diff", async () => {
		const failReport = await runConformanceSuite(
			toySuite(),
			subtractOutputAdapter,
			{
				seed: "hobo-5-stable-seed",
			},
		);

		expect(failReport.ok).toBe(false);
		expect(failReport.claim.status).toBe("blocked");
		expect(failReport.failures[0]).toEqual({
			code: "adapter.output-mismatch",
			caseId: "adds-two-numbers",
			function: "add",
			diff: {
				path: "$.sum",
				expected: 5,
				actual: -1,
			},
		});
	});

	it("golden-IR and replay trace regressions are reported separately", async () => {
		const report = await runConformanceSuite(
			toySuite(),
			goldenAndTraceDriftAdapter,
			{
				seed: "hobo-5-stable-seed",
			},
		);

		expect(report.ok).toBe(false);
		expect(report.failures.map((failure) => failure.code)).toEqual([
			"golden-ir.mismatch",
			"trace-replay.regression",
		]);
		expect(report.failures[0].diff?.path).toBe("$[0].interface");
	});

	it("trace drift mutant fails with trace-replay.regression", async () => {
		const report = await runConformanceSuite(toySuite(), traceDriftAdapter, {
			seed: "hobo-5-stable-seed",
		});

		expect(report.ok).toBe(false);
		expect(
			report.failures.some(
				(failure) => failure.code === "trace-replay.regression",
			),
		).toBe(true);
		expect(
			report.failures.find(
				(failure) => failure.code === "trace-replay.regression",
			)?.diff?.path,
		).toBe("$[0].output.sum");
	});

	it("claimed-but-unexercised port functions fail the coverage manifest", async () => {
		const suite = toySuite({
			port: {
				wit: "hobo:toy-math@0.1.0",
				functions: ["add", "negate"],
			},
			coverage: {
				requiredFunctions: ["add", "negate"],
			},
		});

		const report = await runConformanceSuite(
			suite,
			{
				...passingToyAdapter,
				async negate(input: { value: number }) {
					return {
						output: { value: -input.value },
						goldenIr: [],
						replayTrace: [],
					};
				},
			},
			{ seed: "hobo-5-stable-seed" },
		);

		expect(report.ok).toBe(false);
		expect(report.coverage).toEqual({
			exercisedFunctions: ["add"],
			requiredFunctions: ["add", "negate"],
			unexercisedFunctions: ["negate"],
		});
		expect(report.failures.at(-1)).toEqual({
			code: "coverage.claimed-unexercised",
			functions: ["negate"],
		});
	});

	it("seeded determinism checks reject nondeterministic suites", async () => {
		const suite = createConformanceSuite({
			id: "toy-clock-port",
			port: {
				wit: "hobo:toy-clock@0.1.0",
				functions: ["read"],
			},
			coverage: {
				requiredFunctions: ["read"],
			},
			cases: [
				{
					id: "reads-clock",
					exercises: ["read"],
					call: {
						function: "read",
						input: {},
					},
					expect: {
						goldenIr: [
							{ op: "wit.call", interface: "hobo:toy-clock/read@0.1.0" },
						],
						replayTrace: [{ function: "read" }],
					},
				},
			],
		});

		const report = await runConformanceSuite(suite, nondeterministicAdapter, {
			seed: "hobo-5-stable-seed",
		});

		expect(report.ok).toBe(false);
		expect(report.failures[0].code).toBe("determinism.seed-drift");
		expect(report.failures[0].diff?.path).toBe("$.output.tick");
		expect(report.failures[0].seed).toBe("hobo-5-stable-seed");
	});

	it("missing adapter function yields adapter.missing-function", async () => {
		const report = await runConformanceSuite(
			toySuite(),
			missingFunctionAdapter,
			{
				seed: "hobo-5-stable-seed",
			},
		);

		expect(report.ok).toBe(false);
		expect(report.failures[0].code).toBe("adapter.missing-function");
	});

	it("throwing adapter yields adapter.threw", async () => {
		const report = await runConformanceSuite(toySuite(), throwingAdapter, {
			seed: "hobo-5-stable-seed",
		});

		expect(report.ok).toBe(false);
		expect(report.failures[0].code).toBe("adapter.threw");
	});

	it("language leak in golden IR yields golden-ir.language-leak", async () => {
		const report = await runConformanceSuite(toySuite(), languageLeakAdapter, {
			seed: "hobo-5-stable-seed",
		});

		expect(report.ok).toBe(false);
		expect(
			report.failures.some(
				(failure) => failure.code === "golden-ir.language-leak",
			),
		).toBe(true);
	});

	it("SDK parity rejects language-specific golden IR and missing annex vectors", () => {
		const report = evaluateSdkParity({
			language: "typescript",
			goldenIr: {
				equivalent: true,
				ir: [
					{
						op: "wit.call",
						interface: "hobo:toy-math/add@0.1.0",
						language: "typescript",
					},
				],
			},
			semanticsAnnex: {
				vectors: [
					{ category: "error-mapping", passed: true },
					{ category: "async-ordering", passed: true },
				],
			},
		});

		expect(report.ok).toBe(false);
		expect(report.failures).toEqual([
			{
				code: "golden-ir.language-leak",
				path: "$[0].language",
				language: "typescript",
			},
			{
				code: "semantics-annex.missing-vector",
				categories: ["cancellation", "ifc-side-effect-order"],
			},
		]);
	});

	it("event-log replay reproduces the report byte-for-byte", async () => {
		const report = await runConformanceSuite(toySuite(), passingToyAdapter, {
			seed: "hobo-5-stable-seed",
		});

		const replayed = replayPortSuiteReport(report);
		expect(JSON.stringify(replayed)).toBe(JSON.stringify(report));
	});

	it("repeated runs with stable seed produce byte-identical reports", async () => {
		const first = await runConformanceSuite(toySuite(), passingToyAdapter, {
			seed: "hobo-5-stable-seed",
		});
		const second = await runConformanceSuite(toySuite(), passingToyAdapter, {
			seed: "hobo-5-stable-seed",
		});

		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
	});

	it("adapter registry resolves adapters by id", async () => {
		const registry = createAdapterRegistry();
		registry.register(passingToyAdapter);

		const report = await runConformanceSuite(toySuite(), passingToyAdapter.id, {
			seed: "hobo-5-stable-seed",
			registry,
		});

		expect(report.ok).toBe(true);
		expect(report.adapterId).toBe("toy-adapter-good");
	});

	it("skips non-selected tiers without failing coverage", async () => {
		const suite = createConformanceSuite({
			id: "camp-only-port",
			port: {
				wit: "hobo:camp-only@0.1.0",
				functions: ["provision"],
			},
			coverage: {
				requiredFunctions: ["provision"],
			},
			cases: [
				{
					id: "camp-case",
					tier: "camp",
					exercises: ["provision"],
					call: {
						function: "provision",
						input: {},
					},
					expect: {
						output: { ok: true },
					},
				},
			],
		});

		const report = await runConformanceSuite(
			suite,
			{
				id: "camp-adapter",
				async provision() {
					return { output: { ok: true }, goldenIr: [], replayTrace: [] };
				},
			},
			{ tiers: ["local"], seed: "hobo-5-stable-seed" },
		);

		expect(report.ok).toBe(true);
		expect(report.coverage.unexercisedFunctions).toEqual(["provision"]);
		expect(report.failures).toEqual([]);
	});
});

const packageRoot = dirname(fileURLToPath(import.meta.url));

describe("pact fixture presence", () => {
	it("loads the checked-in consumer pact", () => {
		const pact = JSON.parse(
			readFileSync(
				join(packageRoot, "../contracts/conformance-report.consumer.pact.json"),
				"utf8",
			),
		);
		expect(pact.consumer.name).toBe("ConformanceReportConsumer");
		expect(pact.interactions).toHaveLength(2);
	});
});
