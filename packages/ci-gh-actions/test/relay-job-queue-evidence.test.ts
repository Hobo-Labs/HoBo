import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_QUEUE_LIMITS,
	type QueueJob,
	queueEvidence,
	queueJobsOf,
	queueRunsOf,
	refusingJobs,
	runsJustAhead,
	runsToRead,
	takingJobs,
} from "../src/relay-job/queue-evidence.js";

const recorded = JSON.parse(
	readFileSync(
		new URL("./fixtures/relay-job/recorded-queue.json", import.meta.url),
		"utf8",
	),
);
const readAtMs = Date.parse(recorded.readAt);
const CI_RUN = 43987736809;
const PROBE_RUN = 43987743490;

function recordedJobs(): QueueJob[] {
	return [CI_RUN, PROBE_RUN].flatMap(
		(id) => queueJobsOf(recorded.jobs[String(id)])?.jobs ?? [],
	);
}

const MINUTE = 60_000;
const NOW = Date.parse("2026-11-17T12:00:00Z");

function job(
	label: string,
	queuedMinutesAgo: number,
	startedMinutesAgo?: number,
): QueueJob {
	return {
		runId: 1,
		labels: [label],
		createdAtMs: NOW - queuedMinutesAgo * MINUTE,
		startedAtMs:
			startedMinutesAgo === undefined
				? undefined
				: NOW - startedMinutesAgo * MINUTE,
	};
}

describe("queue evidence from a recorded job list", () => {
	it("reads the run list GitHub answered", () => {
		const runs = queueRunsOf(recorded.runs) ?? [];
		expect(runs).toHaveLength(20);
		expect(runs.filter((run) => run.probe).map((run) => run.id)).toContain(
			PROBE_RUN,
		);
		expect(runs.find((run) => run.id === CI_RUN)?.finished).toBe(false);
	});

	it("counts a pending job with no runner as waiting and drops skipped jobs", () => {
		const page = queueJobsOf(recorded.jobs[String(PROBE_RUN)]);
		expect(page?.chosen).toBe(true);
		const labels = page?.jobs.map((seen) => seen.labels.join(","));
		expect(labels).toEqual(["ubuntu-24.04", "hobo", "hobo-trunk"]);
		expect(page?.jobs[1]?.startedAtMs).toBeUndefined();
	});

	it("shows the waiting fleet label refusing and the trunk label taking", () => {
		const jobs = recordedJobs();
		const fleet = queueEvidence(jobs, "hobo", readAtMs);
		expect(fleet).toEqual({
			waiting: 1,
			oldestWaitSeconds: 253,
			recentPickups: 0,
			slowestRecentPickupSeconds: 0,
			lastPickupAtMs: 0,
		});
		expect(refusingJobs(fleet)).toBe(true);
		expect(takingJobs(fleet)).toBe(false);
		const trunk = queueEvidence(jobs, "HOBO-TRUNK", readAtMs);
		expect(trunk.recentPickups).toBe(1);
		expect(trunk.slowestRecentPickupSeconds).toBe(1);
		expect(takingJobs(trunk)).toBe(true);
	});

	it("sums GitHub-hosted pickups across both runs", () => {
		const hosted = queueEvidence(recordedJobs(), "ubuntu-24.04", readAtMs);
		expect(hosted.waiting).toBe(0);
		expect(hosted.recentPickups).toBe(18);
		expect(hosted.slowestRecentPickupSeconds).toBe(4);
		expect(hosted.lastPickupAtMs).toBe(Date.parse("2026-11-17T00:29:14Z"));
	});

	it("reads probes, the slowest finished runs, the runs just ahead, then the rest", () => {
		const runs = queueRunsOf(recorded.runs) ?? [];
		expect(runsJustAhead(runs, CI_RUN, readAtMs)).toEqual([43987736727]);
		expect(runsToRead(runs, CI_RUN, readAtMs, 20)).toEqual([
			43987743490, 43987211012, 43987084431, 43986621659, 43987077279,
			43986621267, 43987736727, 43987077144, 43987203397,
		]);
		expect(runsToRead(runs, CI_RUN, readAtMs, 4)).toHaveLength(4);
		expect(runsToRead(runs, CI_RUN, readAtMs, 20)).not.toContain(CI_RUN);
	});

	it("takes a run missing from the list as starting now", () => {
		const runs = queueRunsOf(recorded.runs) ?? [];
		expect(runsJustAhead(runs, 43987800000, readAtMs)).toEqual([]);
	});
});

describe("the route job's queue rules", () => {
	it("needs a recent pickup before a label is taking jobs", () => {
		expect(takingJobs(queueEvidence([], "hobo", NOW))).toBe(false);
		expect(takingJobs(queueEvidence([job("hobo", 5, 5)], "hobo", NOW))).toBe(
			true,
		);
		expect(
			takingJobs(queueEvidence([job("hobo", 20, 20)], "hobo", NOW)),
		).toBe(false);
	});

	it("refuses on a long wait, a slow pickup or a full queue", () => {
		const longWait = queueEvidence(
			[job("hobo", 5, 5), job("hobo", 3)],
			"hobo",
			NOW,
		);
		expect(refusingJobs(longWait)).toBe(true);
		const slowPickup = queueEvidence([job("hobo", 50, 45)], "hobo", NOW);
		expect(slowPickup.slowestRecentPickupSeconds).toBe(300);
		expect(refusingJobs(slowPickup)).toBe(true);
		const full = queueEvidence(
			[job("hobo", 1, 1), ...[0, 0, 0, 0].map(() => job("hobo", 0))],
			"hobo",
			NOW,
		);
		expect(full.waiting).toBe(4);
		expect(refusingJobs(full, DEFAULT_QUEUE_LIMITS)).toBe(true);
		expect(refusingJobs(full, { maxWaitSeconds: 120, maxQueued: 5 })).toBe(
			false,
		);
	});

	it("ignores abandoned jobs and jobs that asked for more than the one label", () => {
		const evidence = queueEvidence(
			[
				job("hobo", 25 * 60),
				{ ...job("hobo", 3), labels: ["hobo", "linux"] },
			],
			"hobo",
			NOW,
		);
		expect(evidence.waiting).toBe(0);
	});

	it("refuses anything that is not a GitHub page", () => {
		expect(queueRunsOf({ nope: [] })).toBeUndefined();
		expect(queueJobsOf("not json")).toBeUndefined();
	});
});
