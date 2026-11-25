import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	containerCases,
	createReplayConformanceRunner,
	offlineCases,
	type PackConformanceCase,
	PackError,
	parseConformanceCases,
	parsePackManifest,
	runPackConformance,
	verifyPackManifest,
} from "../src/index.js";
import { FIXTURE_ANCHORS, fixtureManifest, stubVerifier } from "./harness.js";

const manifest = verifyPackManifest({
	manifest: parsePackManifest(fixtureManifest()),
	verifier: stubVerifier("valid"),
	anchors: {
		trustedKeyIds: [...FIXTURE_ANCHORS.trustedKeyIds],
		allowedRegistries: [...FIXTURE_ANCHORS.allowedRegistries],
	},
	requestedArchitecture: "linux/amd64",
});

const CASES: readonly PackConformanceCase[] = [
	{
		id: "accepts-connections",
		profileRef: "kv.key-value/v1",
		description:
			"The declared port accepts a connection once readiness passes.",
		requires: "container-runtime",
		steps: [{ kind: "tcp-connect", portName: "main", expectReachable: true }],
	},
	{
		id: "reports-version",
		profileRef: "kv.key-value/v1",
		description: "The image reports the version the manifest claims.",
		requires: "none",
		steps: [
			{
				kind: "exec",
				argv: ["/usr/local/bin/example", "--version"],
				expectExitCode: 0,
				expectStdoutContains: "example 1.0.0",
			},
		],
	},
];

describe("conformance case parsing", () => {
	it("sorts cases and accepts a well-formed suite", () => {
		const parsed = parseConformanceCases(CASES, manifest);
		assert.deepEqual(
			parsed.map((testCase) => testCase.id),
			["accepts-connections", "reports-version"],
		);
	});

	it("rejects an empty suite instead of reporting a vacuous pass", () => {
		assert.throws(() => parseConformanceCases([], manifest), PackError);
	});

	it("rejects a case that references a port the pack does not declare", () => {
		assert.throws(
			() =>
				parseConformanceCases(
					[
						{
							id: "wrong-port",
							profileRef: "kv.key-value/v1",
							description: "Connects to a port that does not exist.",
							requires: "container-runtime",
							steps: [
								{
									kind: "tcp-connect",
									portName: "metrics",
									expectReachable: true,
								},
							],
						},
					],
					manifest,
				),
			PackError,
		);
	});

	it("rejects duplicate case ids", () => {
		assert.throws(
			() =>
				parseConformanceCases(
					[...CASES, CASES[1] as PackConformanceCase],
					manifest,
				),
			PackError,
		);
	});

	it("rejects a case with no steps", () => {
		assert.throws(
			() =>
				parseConformanceCases(
					[
						{
							id: "empty",
							profileRef: "kv.key-value/v1",
							description: "Proves nothing.",
							requires: "none",
							steps: [],
						},
					],
					manifest,
				),
			PackError,
		);
	});

	it("separates the offline lane from the container lane", () => {
		assert.deepEqual(
			offlineCases(CASES).map((testCase) => testCase.id),
			["reports-version"],
		);
		assert.deepEqual(
			containerCases(CASES).map((testCase) => testCase.id),
			["accepts-connections"],
		);
	});
});

describe("runPackConformance", () => {
	it("passes when every recorded outcome satisfies its step", async () => {
		const report = await runPackConformance({
			manifest,
			cases: offlineCases(CASES),
			runner: createReplayConformanceRunner([
				{
					caseId: "reports-version",
					stepIndex: 0,
					outcome: { ok: true, exitCode: 0, stdout: "example 1.0.0\n" },
				},
			]),
		});
		assert.equal(report.outcome, "pass");
		assert.equal(report.imageDigest, manifest.selectedImage.digest);
		assert.equal(report.architecture, "linux/amd64");
		assert.equal(report.results[0]?.outcome, "pass");
	});

	it("fails a step whose exit code differs from the expectation", async () => {
		const report = await runPackConformance({
			manifest,
			cases: offlineCases(CASES),
			runner: createReplayConformanceRunner([
				{
					caseId: "reports-version",
					stepIndex: 0,
					outcome: { ok: true, exitCode: 1 },
				},
			]),
		});
		assert.equal(report.outcome, "fail");
		assert.equal(report.results[0]?.failedStepIndex, 0);
	});

	it("fails a step whose stdout lacks the expected marker even at exit 0", async () => {
		const report = await runPackConformance({
			manifest,
			cases: offlineCases(CASES),
			runner: createReplayConformanceRunner([
				{
					caseId: "reports-version",
					stepIndex: 0,
					outcome: { ok: true, exitCode: 0, stdout: "example 0.9.0" },
				},
			]),
		});
		assert.equal(report.outcome, "fail");
	});

	it("stops a case at its first failing step rather than cascading", async () => {
		const attempted: number[] = [];
		const report = await runPackConformance({
			manifest,
			cases: [
				{
					id: "multi-step",
					profileRef: "kv.key-value/v1",
					description: "Three steps where the first fails.",
					requires: "none",
					steps: [
						{ kind: "exec", argv: ["/bin/first"], expectExitCode: 0 },
						{ kind: "exec", argv: ["/bin/second"], expectExitCode: 0 },
						{ kind: "restart-workload", reason: "confirm durability" },
					],
				},
			],
			runner: {
				run(request) {
					attempted.push(request.stepIndex);
					return Promise.resolve({ ok: false, detail: "runner refused" });
				},
			},
		});
		assert.deepEqual(attempted, [0]);
		assert.equal(report.results[0]?.detail, "runner refused");
	});

	it("treats an unrecorded step as an error, never as an implicit pass", async () => {
		await assert.rejects(
			runPackConformance({
				manifest,
				cases: offlineCases(CASES),
				runner: createReplayConformanceRunner([]),
			}),
			PackError,
		);
	});
});
