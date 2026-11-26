/**
 * The mandatory lane never starts a container. It replays recorded outcomes, so
 * what these tests prove is that the suite is well-formed, honestly classified,
 * and that a failure is reported as a failure — not that PostgreSQL works.
 */
import {
	containerCases,
	createReplayConformanceRunner,
	offlineCases,
	PackError,
	parseConformanceCases,
	type RecordedStepOutcome,
	runPackConformance,
} from "@hobo/pack-framework";
import { describe, expect, it } from "vitest";

import {
	POSTGRES_CONFORMANCE_CASES,
	POSTGRES_SERVER_VERSION,
} from "../src/index.js";
import { verifiedPostgresPack } from "./harness.js";

/** A recording where every step of every case succeeds as declared. */
function passingRecording(): RecordedStepOutcome[] {
	const recorded: RecordedStepOutcome[] = [];
	for (const testCase of POSTGRES_CONFORMANCE_CASES) {
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

describe("postgres conformance suite", () => {
	it("declares every case against a profile this pack actually claims", () => {
		const manifest = verifiedPostgresPack();
		const cases = parseConformanceCases(POSTGRES_CONFORMANCE_CASES, manifest);
		const claimed = new Set([
			...manifest.implementsProfiles.map((entry) => entry.profileId),
			"migration.postgres.pg-dump/v1",
		]);
		for (const testCase of cases) {
			expect(claimed.has(testCase.profileRef)).toBe(true);
		}
		// Both refinement levels carry their own evidence, so a requirement for
		// either one is backed by a case rather than by the refinement graph.
		const profiles = cases.map((testCase) => testCase.profileRef);
		expect(profiles).toContain("data.postgres/v1");
		expect(profiles).toContain("data.relational/v1");
	});

	it("classifies every case as container-gated, because the tooling lives in the image", () => {
		expect(offlineCases(POSTGRES_CONFORMANCE_CASES)).toEqual([]);
		expect(containerCases(POSTGRES_CONFORMANCE_CASES)).toHaveLength(
			POSTGRES_CONFORMANCE_CASES.length,
		);
	});

	it("pins the version assertion to the manifest's server version", () => {
		const versionCase = POSTGRES_CONFORMANCE_CASES.find(
			(testCase) => testCase.id === "server-version-matches-manifest",
		);
		const step = versionCase?.steps[0];
		expect(step?.kind).toBe("exec");
		if (step?.kind !== "exec") throw new Error("expected an exec step");
		expect(step.expectStdoutContains).toBe(POSTGRES_SERVER_VERSION);
	});

	it("proves durability by restarting between the write and the read", () => {
		const durability = POSTGRES_CONFORMANCE_CASES.find(
			(testCase) => testCase.id === "survives-restart",
		);
		const kinds = durability?.steps.map((step) => step.kind);
		expect(kinds).toEqual(["exec", "restart-workload", "exec"]);
	});

	it("reports a pass from a recording where every step meets its expectation", async () => {
		const manifest = verifiedPostgresPack();
		const report = await runPackConformance({
			manifest,
			cases: POSTGRES_CONFORMANCE_CASES,
			runner: createReplayConformanceRunner(passingRecording()),
		});
		expect(report.outcome).toBe("pass");
		expect(report.packId).toBe("pack.postgres.oci/v1");
		// Evidence is scoped to the bytes it was gathered against.
		expect(report.imageDigest).toBe(manifest.selectedImage.digest);
		expect(report.results).toHaveLength(POSTGRES_CONFORMANCE_CASES.length);
	});

	it("fails the durability case when the row does not survive the restart", async () => {
		const recording = passingRecording().map((entry) =>
			entry.caseId === "survives-restart" && entry.stepIndex === 2
				? { ...entry, outcome: { ok: true, exitCode: 0, stdout: "(0 rows)" } }
				: entry,
		);
		const report = await runPackConformance({
			manifest: verifiedPostgresPack(),
			cases: POSTGRES_CONFORMANCE_CASES,
			runner: createReplayConformanceRunner(recording),
		});
		expect(report.outcome).toBe("fail");
		const durability = report.results.find(
			(result) => result.caseId === "survives-restart",
		);
		expect(durability?.outcome).toBe("fail");
		expect(durability?.failedStepIndex).toBe(2);
	});

	it("treats an unrecorded step as an error rather than an implicit pass", async () => {
		await expect(
			runPackConformance({
				manifest: verifiedPostgresPack(),
				cases: POSTGRES_CONFORMANCE_CASES,
				runner: createReplayConformanceRunner([]),
			}),
		).rejects.toBeInstanceOf(PackError);
	});
});
