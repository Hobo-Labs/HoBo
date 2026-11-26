/**
 * The mandatory lane never starts a container: it replays recorded outcomes. What
 * these tests prove is that the suite is well-formed and that it asserts the
 * behaviour the chosen durability mode actually claims — including the case where
 * the claim is "this data is gone after a restart".
 */
import {
	containerCases,
	createReplayConformanceRunner,
	offlineCases,
	type PackConformanceCase,
	PackError,
	parseConformanceCases,
	type RecordedStepOutcome,
	runPackConformance,
} from "@hobo/pack-framework";
import { describe, expect, it } from "vitest";

import {
	VALKEY_DURABILITY_MODES,
	VALKEY_SERVER_VERSION,
	valkeyConformanceCases,
} from "../src/index.js";
import { verifiedValkeyPack } from "./harness.js";

const manifest = verifiedValkeyPack();

function passingRecording(
	cases: readonly PackConformanceCase[],
): RecordedStepOutcome[] {
	const recorded: RecordedStepOutcome[] = [];
	for (const testCase of cases) {
		for (const [stepIndex, step] of testCase.steps.entries()) {
			switch (step.kind) {
				case "exec":
					recorded.push({
						caseId: testCase.id,
						stepIndex,
						outcome: {
							ok: true,
							exitCode: step.expectExitCode,
							stdout: step.expectStdoutContains ?? "",
						},
					});
					break;
				case "tcp-connect":
					recorded.push({
						caseId: testCase.id,
						stepIndex,
						outcome: { ok: true, reachable: step.expectReachable },
					});
					break;
				case "http-get":
					recorded.push({
						caseId: testCase.id,
						stepIndex,
						outcome: { ok: true, status: step.expectStatus },
					});
					break;
				case "restart-workload":
					recorded.push({
						caseId: testCase.id,
						stepIndex,
						outcome: { ok: true },
					});
					break;
			}
		}
	}
	return recorded;
}

describe("valkey conformance suite", () => {
	it("is well-formed for every durability mode", () => {
		for (const mode of VALKEY_DURABILITY_MODES) {
			const cases = parseConformanceCases(
				valkeyConformanceCases(mode),
				manifest,
			);
			expect(cases.length).toBeGreaterThan(0);
		}
	});

	it("claims no case can be evidenced without the image", () => {
		const cases = valkeyConformanceCases("aof-everysec");
		expect(offlineCases(cases)).toEqual([]);
		expect(containerCases(cases)).toHaveLength(cases.length);
	});

	it("pins the version assertion to the manifest's server version", () => {
		const versionCase = valkeyConformanceCases("aof-everysec").find(
			(testCase) => testCase.id === "server-version-matches-manifest",
		);
		const step = versionCase?.steps[0];
		if (step?.kind !== "exec") throw new Error("expected an exec step");
		expect(step.expectStdoutContains).toBe(VALKEY_SERVER_VERSION);
	});

	it("asserts the keyspace survives a restart in a durable mode", () => {
		const cases = valkeyConformanceCases("aof-everysec");
		const durability = cases.find(
			(testCase) => testCase.id === "survives-restart",
		);
		expect(durability?.steps.map((step) => step.kind)).toEqual([
			"exec",
			"restart-workload",
			"exec",
		]);
	});

	it("forces a save before the restart in snapshot mode", () => {
		// Otherwise the case would be testing whether the schedule happened to
		// have run, not whether the volume holds the keyspace.
		const durability = valkeyConformanceCases("rdb-snapshots").find(
			(testCase) => testCase.id === "survives-restart",
		);
		const second = durability?.steps[1];
		if (second?.kind !== "exec") throw new Error("expected a SAVE step");
		expect(second.argv).toContain("SAVE");
	});

	it("asserts the documented loss actually happens in cache mode", () => {
		const cases = valkeyConformanceCases("none");
		expect(cases.some((testCase) => testCase.id === "survives-restart")).toBe(
			false,
		);
		const loss = cases.find(
			(testCase) => testCase.id === "cache-mode-starts-empty-after-restart",
		);
		const last = loss?.steps.at(-1);
		if (last?.kind !== "exec") throw new Error("expected an EXISTS step");
		expect(last.expectStdoutContains).toBe("0");
	});

	it("covers authentication enforcement, expiry, increment, and sorted sets", () => {
		const ids = valkeyConformanceCases("aof-everysec").map(
			(testCase) => testCase.id,
		);
		expect(ids).toContain("refuses-unauthenticated-command");
		expect(ids).toContain("supports-per-key-expiry");
		expect(ids).toContain("supports-atomic-increment");
		expect(ids).toContain("supports-sorted-sets");
	});

	it("has no case claiming a queue or topic guarantee", () => {
		for (const mode of VALKEY_DURABILITY_MODES) {
			for (const testCase of valkeyConformanceCases(mode)) {
				expect(testCase.profileRef.startsWith("kv.")).toBe(true);
			}
		}
	});

	it("reports a pass from a recording where every step meets its expectation", async () => {
		const cases = valkeyConformanceCases("aof-everysec");
		const report = await runPackConformance({
			manifest,
			cases,
			runner: createReplayConformanceRunner(passingRecording(cases)),
		});
		expect(report.outcome).toBe("pass");
		expect(report.packId).toBe("pack.valkey.oci/v1");
		expect(report.imageDigest).toBe(manifest.selectedImage.digest);
	});

	it("fails when an unauthenticated command is answered instead of refused", async () => {
		const cases = valkeyConformanceCases("aof-everysec");
		const recording = passingRecording(cases).map((entry) =>
			entry.caseId === "refuses-unauthenticated-command"
				? {
						...entry,
						outcome: { ok: true, exitCode: 0, stdout: '"a-real-value"' },
					}
				: entry,
		);
		const report = await runPackConformance({
			manifest,
			cases,
			runner: createReplayConformanceRunner(recording),
		});
		expect(report.outcome).toBe("fail");
		const auth = report.results.find(
			(result) => result.caseId === "refuses-unauthenticated-command",
		);
		expect(auth?.outcome).toBe("fail");
	});

	it("treats an unrecorded step as an error rather than an implicit pass", async () => {
		await expect(
			runPackConformance({
				manifest,
				cases: valkeyConformanceCases("aof-everysec"),
				runner: createReplayConformanceRunner([]),
			}),
		).rejects.toBeInstanceOf(PackError);
	});
});
