import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	BURST_SECONDS,
	chooseRunner,
	DEFAULT_MAX_QUEUED,
	DEFAULT_MAX_WAIT_SECONDS,
	fleetLabelFor,
	hasChosen,
	type LabelLoad,
	labelLoad,
	lookupOrder,
	MAX_PROBE_LOOKUPS,
	MAX_RUN_LOOKUPS,
	main,
	observeQueue,
	PROBE_POLL_SECONDS,
	PROBE_WAIT_SECONDS,
	PROBE_WORKFLOW_PATH,
	parseRouteMode,
	probeRunIds,
	type QueueView,
	RECENT_PICKUP_SECONDS,
	refusingJobs,
	routeRunner,
	runsJustAhead,
	type SeenJob,
	STALE_WAIT_SECONDS,
	seenJobs,
	takingJobs,
	unfinishedRunIds,
} from "../ci/route-runner.mts";

const NOW = Date.parse("2026-11-10T18:00:00Z");
const limits = {
	maxWaitSeconds: DEFAULT_MAX_WAIT_SECONDS,
	maxQueued: DEFAULT_MAX_QUEUED,
};
const waiting = (label: string, seconds: number, runId = 1): SeenJob => ({
	runId,
	labels: [label],
	createdAtMs: NOW - seconds * 1000,
});
/** A job a runner took `ago` seconds ago, after it had waited `waited` seconds. */
const taken = (label: string, waited: number, ago: number): SeenJob => ({
	runId: 1,
	labels: [label],
	createdAtMs: NOW - (ago + waited) * 1000,
	startedAtMs: NOW - ago * 1000,
});
/** Nothing waiting and nothing seen: a label no runner is known to serve. */
const idle: LabelLoad = {
	queued: 0,
	oldestWaitSeconds: 0,
	recentPickups: 0,
	slowestRecentPickupSeconds: 0,
};
/** Nothing waiting, and a runner took a job a moment ago without delay. */
const up: LabelLoad = { ...idle, recentPickups: 1 };
const decide = (overrides: Partial<Parameters<typeof routeRunner>[0]> = {}) =>
	routeRunner({
		mode: "auto",
		fleetLabel: "hobo",
		localEnrolled: false,
		limits,
		fleet: up,
		local: up,
		undecidedAhead: 0,
		...overrides,
	});

const trunkCapacity = {
	freeSlots: 1,
	requiredMb: 4096,
	reserveMb: 2048,
	volatilityMb: 1024,
	availableMb: 2400,
	admit: false,
};

describe("the load on a label", () => {
	it("counts jobs asking for exactly that label and takes the oldest wait", () => {
		const jobs = [
			waiting("hobo", 40),
			waiting("hobo", 900),
			waiting("hobo-trunk", 5000),
			{ runId: 2, labels: ["hobo", "gpu"], createdAtMs: NOW - 9_000_000 },
		];
		assert.deepEqual(labelLoad(jobs, "hobo", NOW), {
			queued: 2,
			oldestWaitSeconds: 900,
			recentPickups: 0,
			slowestRecentPickupSeconds: 0,
		});
		assert.deepEqual(labelLoad(jobs, "hobo-local-host", NOW), idle);
	});

	it("matches the label whatever its case", () => {
		assert.equal(labelLoad([waiting("HoBo", 30)], "hobo", NOW).queued, 1);
	});

	it("ignores a job queued so long it was abandoned", () => {
		const jobs = [waiting("hobo", STALE_WAIT_SECONDS + 1), waiting("hobo", 10)];
		assert.deepEqual(labelLoad(jobs, "hobo", NOW), {
			queued: 1,
			oldestWaitSeconds: 10,
			recentPickups: 0,
			slowestRecentPickupSeconds: 0,
		});
	});

	it("remembers how long recently taken jobs waited, and forgets old ones", () => {
		const jobs = [
			taken("hobo", 20, 60),
			taken("hobo", 1500, 300),
			taken("hobo", 9000, RECENT_PICKUP_SECONDS + 1),
			taken("hobo-trunk", 4000, 10),
		];
		assert.deepEqual(labelLoad(jobs, "hobo", NOW), {
			queued: 0,
			oldestWaitSeconds: 0,
			recentPickups: 2,
			slowestRecentPickupSeconds: 1500,
		});
	});
});

describe("whether a backend is taking jobs", () => {
	it("is while a runner took a job recently and nothing is past a limit", () => {
		assert.equal(takingJobs(up, limits), true);
		assert.equal(
			takingJobs(
				{
					queued: DEFAULT_MAX_QUEUED - 1,
					oldestWaitSeconds: DEFAULT_MAX_WAIT_SECONDS - 1,
					recentPickups: 1,
					slowestRecentPickupSeconds: DEFAULT_MAX_WAIT_SECONDS - 1,
				},
				limits,
			),
			true,
		);
	});

	// What happened: the merge queue was rebuilt, ten runs chose in the same
	// second, each saw nothing waiting for the fleet, and all ten joined a
	// fleet that was taking minutes to pick a job up.
	it("is not on an empty queue alone: no runner has been seen to take a job", () => {
		assert.equal(takingJobs(idle, limits), false);
		assert.equal(refusingJobs(idle, limits), false);
	});

	it("is not once a job has waited past the limit", () => {
		assert.equal(
			takingJobs({ ...up, queued: 1, oldestWaitSeconds: 120 }, limits),
			false,
		);
	});

	// What happened: a queue emptied by cancelled runs refilled with eleven
	// jobs, the oldest 283 s old against a 300 s limit, and the next run joined it.
	it("is not once many jobs are waiting, however young the oldest is", () => {
		assert.equal(
			takingJobs({ ...up, queued: 11, oldestWaitSeconds: 30 }, limits),
			false,
		);
		assert.equal(
			takingJobs({ ...up, queued: DEFAULT_MAX_QUEUED }, limits),
			false,
		);
	});

	it("is not while it was recently slow to pick a job up, even with nothing waiting", () => {
		assert.equal(
			takingJobs({ ...up, slowestRecentPickupSeconds: 1500 }, limits),
			false,
		);
	});
});

describe("the routing decision", () => {
	it("stays on the fleet while it is taking jobs", () => {
		assert.deepEqual([decide().tier, decide().runner], ["fleet", "hobo"]);
	});

	it("goes to GitHub-hosted when the fleet is not taking jobs and no local box is enrolled", () => {
		const routed = decide({
			fleet: { ...idle, queued: 38, oldestWaitSeconds: 3600 },
		});
		assert.equal(routed.tier, "github");
		assert.equal(routed.runner, "ubuntu-24.04");
		assert.match(routed.reason, /38 waiting, the oldest for 3600 s/);
		assert.match(routed.reason, /no local box is enrolled/);
		assert.match(routed.reason, /limits are 120 s and 4 waiting/);
	});

	it("says so when the reason is a slow recent pickup", () => {
		const routed = decide({
			fleet: { ...up, slowestRecentPickupSeconds: 1500 },
		});
		assert.equal(routed.tier, "github");
		assert.match(routed.reason, /recently took up to 1500 s to pick a job up/);
	});

	it("goes to GitHub-hosted, and says why, when no runner has been seen on the fleet", () => {
		const routed = decide({ fleet: idle });
		assert.equal(routed.tier, "github");
		assert.match(
			routed.reason,
			/the fleet has nothing waiting, and has not been seen to pick a job up in the last 15 minutes/,
		);
	});

	it("leaves the self-hosted runners to a run that started just ahead and has not chosen", () => {
		const routed = decide({ localEnrolled: true, undecidedAhead: 2 });
		assert.equal(routed.tier, "github");
		assert.match(
			routed.reason,
			/2 run\(s\) started in the 60 s before this one and have not chosen a runner yet/,
		);
	});

	it("prefers an enrolled local box over GitHub-hosted", () => {
		const routed = decide({
			localEnrolled: true,
			fleet: { ...idle, queued: 4, oldestWaitSeconds: 900 },
		});
		assert.equal(routed.tier, "local");
		assert.equal(routed.runner, "hobo-local-host");
	});

	it("passes over a local box that is enrolled but not taking jobs", () => {
		const routed = decide({
			localEnrolled: true,
			fleet: { ...idle, queued: 4, oldestWaitSeconds: 900 },
			local: { ...idle, queued: 1, oldestWaitSeconds: 600 },
		});
		assert.equal(routed.tier, "github");
		assert.match(routed.reason, /the local box has 1 waiting/);
	});

	it("never asks an unenrolled local box, however idle its label looks", () => {
		const routed = decide({
			fleet: { ...idle, queued: 1, oldestWaitSeconds: 301 },
		});
		assert.equal(routed.tier, "github");
	});

	it("asks the fleet for the trunk label on trunk events", () => {
		assert.equal(decide({ fleetLabel: "hobo-trunk" }).runner, "hobo-trunk");
	});

	it("overflows to GitHub-hosted when live capacity refuses trunk jobs", () => {
		const routed = decide({
			fleetLabel: "hobo-trunk",
			fleetCapacity: trunkCapacity,
		});
		assert.equal(routed.tier, "github");
		assert.match(routed.reason, /cannot admit/);
	});

	it("honours a pinned tier without looking at the queue", () => {
		const down = { ...idle, queued: 50, oldestWaitSeconds: 9000 };
		assert.equal(decide({ mode: "fleet", fleet: down }).runner, "hobo");
		assert.equal(decide({ mode: "github" }).runner, "ubuntu-24.04");
		assert.equal(decide({ mode: "local" }).runner, "hobo-local-host");
	});

	it("reads anything but a known mode as auto", () => {
		assert.equal(parseRouteMode(undefined), "auto");
		assert.equal(parseRouteMode(""), "auto");
		assert.equal(parseRouteMode("hosted"), "auto");
		assert.equal(parseRouteMode(" github "), "github");
	});
});

describe("the fleet label a run asks for", () => {
	it("is the trunk label for trunk events unless that is switched off", () => {
		assert.equal(fleetLabelFor("pull_request", undefined), "hobo");
		assert.equal(fleetLabelFor("merge_group", undefined), "hobo-trunk");
		assert.equal(fleetLabelFor("push", ""), "hobo-trunk");
		assert.equal(fleetLabelFor("push", "false"), "hobo");
	});
});

describe("reading GitHub's queue", () => {
	const runsPage = {
		workflow_runs: [
			{ id: 30, status: "queued" },
			{ id: 10, status: "in_progress" },
			{ id: 20, status: "completed" },
			{ id: 40, status: "pending" },
			{ id: 7, status: "queued" },
		],
	};
	const at = (secondsAgo: number) =>
		new Date(NOW - secondsAgo * 1000).toISOString();
	const jobsPage = (runId: number, waited: number, label = "hobo") => ({
		jobs: [
			{
				run_id: runId,
				status: "queued",
				labels: [label],
				created_at: at(waited),
			},
		],
	});

	it("takes unfinished runs oldest first and leaves out this run", () => {
		assert.deepEqual(unfinishedRunIds(runsPage, 7), [10, 30, 40]);
		assert.deepEqual(unfinishedRunIds({ message: "Not Found" }, 7), []);
	});

	it("reads the oldest and the newest runs alternately", () => {
		assert.deepEqual(lookupOrder([1, 2, 3, 4, 5]), [1, 5, 2, 4, 3]);
		assert.deepEqual(lookupOrder([1, 2]), [1, 2]);
		assert.deepEqual(lookupOrder([]), []);
	});

	it("keeps queued jobs and jobs a runner took, with their times", () => {
		const page = {
			jobs: [
				{ run_id: 9, status: "queued", labels: ["hobo"], created_at: at(60) },
				{
					run_id: 9,
					status: "in_progress",
					labels: ["hobo"],
					runner_name: "hobo-1",
					created_at: at(400),
					started_at: at(100),
				},
				{
					run_id: 9,
					status: "completed",
					labels: ["hobo"],
					runner_name: "hobo-2",
					created_at: at(900),
					started_at: at(880),
				},
				// Skipped before it ran: no runner, so it says nothing.
				{
					run_id: 9,
					status: "completed",
					labels: ["hobo"],
					runner_name: "",
					created_at: at(50),
					started_at: at(50),
				},
				{ run_id: 9, status: "queued", labels: ["hobo"] },
				"junk",
			],
		};
		assert.deepEqual(seenJobs(page), [
			waiting("hobo", 60, 9),
			{ ...taken("hobo", 300, 100), runId: 9 },
			{ ...taken("hobo", 20, 880), runId: 9 },
		]);
	});

	it("stops reading once the label is seen not taking jobs", async () => {
		const paths: string[] = [];
		const { jobs } = await observeQueue({
			read: async (path) => {
				paths.push(path);
				if (path.includes("/jobs")) return jobsPage(10, 4000);
				return runsPage;
			},
			repository: "acme/app",
			ownRunId: 7,
			labels: ["hobo"],
			limits,
			nowMs: NOW,
		});
		assert.equal(paths.length, 2);
		assert.equal(paths[0], "/repos/acme/app/actions/runs?per_page=100");
		assert.match(paths[1] ?? "", /\/actions\/runs\/10\/jobs/);
		assert.equal(labelLoad(jobs, "hobo", NOW).oldestWaitSeconds, 4000);
	});

	it("stops once enough jobs are waiting, though none has waited long", async () => {
		const many = {
			workflow_runs: Array.from({ length: 40 }, (_, index) => ({
				id: index + 100,
				status: "queued",
			})),
		};
		let jobLists = 0;
		const { jobs } = await observeQueue({
			read: async (path) => {
				if (!path.includes("/jobs")) return many;
				jobLists += 1;
				return jobsPage(100, 20);
			},
			repository: "acme/app",
			ownRunId: 1,
			labels: ["hobo"],
			limits,
			nowMs: NOW,
		});
		assert.equal(jobLists, DEFAULT_MAX_QUEUED);
		assert.equal(labelLoad(jobs, "hobo", NOW).queued, DEFAULT_MAX_QUEUED);
	});

	it("reads a bounded number of runs when the label is quiet", async () => {
		const many = {
			workflow_runs: Array.from({ length: 40 }, (_, index) => ({
				id: index + 100,
				status: "queued",
			})),
		};
		let jobLists = 0;
		await observeQueue({
			read: async (path) => {
				if (!path.includes("/jobs")) return many;
				jobLists += 1;
				return jobsPage(100, 20, "ubuntu-24.04");
			},
			repository: "acme/app",
			ownRunId: 1,
			labels: ["hobo"],
			limits,
			nowMs: NOW,
		});
		assert.equal(jobLists, MAX_RUN_LOOKUPS);
	});

	const probePage = {
		workflow_runs: [
			{ id: 50, status: "in_progress", created_at: at(5) },
			{ id: 49, status: "queued", created_at: at(20) },
			{ id: 48, status: "queued", path: PROBE_WORKFLOW_PATH },
			{ id: 47, status: "in_progress", created_at: at(BURST_SECONDS + 30) },
			{ id: 46, status: "completed", path: PROBE_WORKFLOW_PATH },
			{ id: 45, status: "completed", created_at: at(10) },
			{ id: 44, status: "completed", path: PROBE_WORKFLOW_PATH },
			{ id: 43, status: "completed", path: PROBE_WORKFLOW_PATH },
			{ id: 51, status: "queued", created_at: at(2) },
		],
	};

	it("takes the newest probe runs, finished or not, and keeps them out of the rest", () => {
		assert.equal(MAX_PROBE_LOOKUPS, 3);
		assert.deepEqual(probeRunIds(probePage), [48, 46, 44]);
		assert.deepEqual(unfinishedRunIds(probePage, 50), [47, 49, 51]);
	});

	it("finds the unfinished runs that started just ahead of this one", () => {
		// 51 started after it, 47 too long before it, 45 has finished.
		assert.deepEqual(runsJustAhead(probePage, 50, NOW), [49]);
		assert.deepEqual(runsJustAhead(probePage, 51, NOW), [50, 49]);
		// A run missing from the page is measured from now.
		assert.deepEqual(runsJustAhead(probePage, 52, NOW), [51, 50, 49]);
	});

	it("takes a run to have chosen once one of its jobs has finished", () => {
		assert.equal(hasChosen({ jobs: [{ status: "in_progress" }] }), false);
		assert.equal(hasChosen({ jobs: [] }), false);
		assert.equal(
			hasChosen({ jobs: [{ status: "completed" }, { status: "queued" }] }),
			true,
		);
	});

	it("reads the probe runs first, then the runs just ahead, and counts those that have not chosen", async () => {
		const read: number[] = [];
		const pickedUp = (runId: number) => ({
			jobs: [
				{
					run_id: runId,
					status: "completed",
					labels: ["hobo"],
					runner_name: "hobo-1",
					created_at: at(65),
					started_at: at(60),
				},
			],
		});
		const view = await observeQueue({
			read: async (path) => {
				const runId = Number(/runs\/(\d+)\/jobs/.exec(path)?.[1]);
				if (Number.isNaN(runId)) return probePage;
				read.push(runId);
				if (runId === 46) return pickedUp(46);
				// 49 has finished its route job; 50 is still on it.
				if (runId === 49) return { jobs: [{ status: "completed" }] };
				return { jobs: [{ status: "in_progress" }] };
			},
			repository: "acme/app",
			ownRunId: 51,
			labels: ["hobo"],
			limits,
			nowMs: NOW,
		});
		assert.deepEqual(read, [48, 46, 44, 50, 49, 47]);
		assert.equal(view.undecidedAhead, 1);
		assert.equal(view.probeUnderway, true);
		const load = labelLoad(view.jobs, "hobo", NOW);
		assert.equal(load.recentPickups, 1);
		assert.equal(takingJobs(load, limits), true);
	});

	it("counts a run just ahead as not having chosen when there was no lookup left for it", async () => {
		const crowd = {
			workflow_runs: Array.from({ length: 12 }, (_, index) => ({
				id: index + 100,
				status: "queued",
				created_at: at(10),
			})),
		};
		const view = await observeQueue({
			read: async (path) =>
				path.includes("/jobs") ? { jobs: [{ status: "completed" }] } : crowd,
			repository: "acme/app",
			ownRunId: 111,
			labels: ["hobo"],
			limits,
			nowMs: NOW,
		});
		assert.equal(view.undecidedAhead, 11 - MAX_RUN_LOOKUPS);
	});
});

describe("waiting for the probe", () => {
	/** Plays out a list of queue views, one per look, on a clock only `sleep` moves. */
	const choose = async (
		views: readonly QueueView[],
		overrides: { localEnrolled?: boolean } = {},
	) => {
		let clock = NOW;
		let looks = 0;
		const decision = await chooseRunner({
			observe: async () => {
				const view = views[Math.min(looks, views.length - 1)];
				looks += 1;
				assert.ok(view);
				return view;
			},
			now: () => clock,
			sleep: async (wait) => {
				clock += wait * 1000;
			},
			mode: "auto",
			fleetLabel: "hobo",
			localEnrolled: overrides.localEnrolled ?? false,
			limits,
		});
		return { decision, looks, waited: (clock - NOW) / 1000 };
	};
	const quiet = { jobs: [], undecidedAhead: 0, probeUnderway: false };
	const probing = { ...quiet, probeUnderway: true };
	// `taken` is relative to NOW; the clock has moved on by the time it is seen.
	const answered = { ...probing, jobs: [taken("hobo", 12, -20)] };

	it("decides at once when the fleet has been seen taking jobs", async () => {
		const seen = await choose([{ ...quiet, jobs: [taken("hobo", 5, 60)] }]);
		assert.deepEqual([seen.decision.tier, seen.looks], ["fleet", 1]);
	});

	it("decides at once when nothing is known and no probe is under way", async () => {
		const seen = await choose([quiet]);
		assert.deepEqual(
			[seen.decision.tier, seen.looks, seen.waited],
			["github", 1, 0],
		);
	});

	it("uses the fleet once the probe is picked up", async () => {
		const seen = await choose([probing, probing, answered]);
		assert.equal(seen.decision.tier, "fleet");
		assert.equal(seen.waited, 2 * PROBE_POLL_SECONDS);
	});

	it("gives up after the wait and says how long it waited", async () => {
		const seen = await choose([probing]);
		assert.equal(seen.decision.tier, "github");
		assert.equal(seen.waited, PROBE_WAIT_SECONDS);
		assert.match(
			seen.decision.reason,
			/waited 60 s for the probe to be picked up/,
		);
	});

	it("does not wait on a fleet that is refusing jobs", async () => {
		const seen = await choose([
			{ ...probing, jobs: [waiting("hobo", 900), waiting("hobo", 10)] },
		]);
		assert.deepEqual([seen.decision.tier, seen.waited], ["github", 0]);
	});

	it("does not wait while a run ahead has yet to choose", async () => {
		const seen = await choose([{ ...probing, undecidedAhead: 1 }]);
		assert.deepEqual([seen.decision.tier, seen.waited], ["github", 0]);
	});

	it("waits for the fleet even when the local box is already taking jobs", async () => {
		const local = taken("hobo-local-host", 5, 30);
		const seen = await choose(
			[
				{ ...probing, jobs: [local] },
				{ ...probing, jobs: [local, taken("hobo", 12, -5)] },
			],
			{ localEnrolled: true },
		);
		assert.deepEqual(
			[seen.decision.tier, seen.waited],
			["fleet", PROBE_POLL_SECONDS],
		);
	});

	it("falls back to the local box when the probe finds only that", async () => {
		const seen = await choose(
			[probing, { ...probing, jobs: [taken("hobo-local-host", 8, -5)] }],
			{ localEnrolled: true },
		);
		assert.equal(seen.decision.tier, "local");
		assert.equal(seen.waited, PROBE_WAIT_SECONDS);
	});
});

describe("the script as a whole", () => {
	it("uses GitHub-hosted, and says why, when the queue cannot be read", async () => {
		const decision = await main({
			GITHUB_EVENT_NAME: "merge_group",
			GITHUB_REPOSITORY: "acme/app",
			GITHUB_RUN_ID: "1",
			GITHUB_API_URL: "http://127.0.0.1:9",
		});
		assert.equal(decision.runner, "ubuntu-24.04");
		assert.equal(decision.tier, "github");
		assert.match(decision.reason, /could not be read/);
	});

	it("does not read the queue for a pinned tier", async () => {
		const pinned = await main({
			GITHUB_EVENT_NAME: "merge_group",
			HOBO_CI_ROUTE: "fleet",
			GITHUB_API_URL: "http://127.0.0.1:9",
		});
		assert.equal(pinned.runner, "hobo-trunk");
		const hosted = await main({
			GITHUB_EVENT_NAME: "pull_request",
			HOBO_CI_ROUTE: "github",
			GITHUB_API_URL: "http://127.0.0.1:9",
		});
		assert.equal(hosted.runner, "ubuntu-24.04");
	});
});
