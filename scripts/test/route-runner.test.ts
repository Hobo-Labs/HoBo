import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import {
	ABSENT_SLIP_WHYS,
	askSlip,
	BURST_SECONDS,
	chooseRunner,
	DEFAULT_LOCAL_RUNNER,
	DEFAULT_MAX_QUEUED,
	DEFAULT_MAX_WAIT_SECONDS,
	DEFAULT_RUNNER_LABELS,
	fleetLabelFor,
	hasChosen,
	type JsonValue,
	type LabelLoad,
	labelLoad,
	lookupOrder,
	MAX_FINISHED_LOOKUPS,
	MAX_PROBE_LOOKUPS,
	MAX_RUN_LOOKUPS,
	main,
	NO_ROUTING_SLIP,
	observeQueue,
	PROBE_POLL_SECONDS,
	PROBE_WAIT_SECONDS,
	PROBE_WORKFLOW_PATH,
	parseRouteArgs,
	parseRouteMode,
	probeRunIds,
	type QueueView,
	RECENT_PICKUP_SECONDS,
	type RouteDecision,
	refusingJobs,
	routeAnnotation,
	routeClass,
	routeRunner,
	routeSettings,
	runsJustAhead,
	type SeenJob,
	SLIP_REFUSAL_WHY,
	SLOW_PICKUP_MEMORY_SECONDS,
	STALE_WAIT_SECONDS,
	seenJobs,
	slowestFinishedRunIds,
	TRUNK_EVENTS,
	takingJobs,
	unfinishedRunIds,
	workflowFile,
} from "../ci/route-runner.mts";
import {
	RUNNER_ROUTING_PATH,
	type RunnerRouting,
	readRunnerRouting,
} from "../ci/runner-routing.mts";

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
			taken("hobo", 9000, SLOW_PICKUP_MEMORY_SECONDS + 1),
			taken("hobo-trunk", 4000, 10),
		];
		assert.deepEqual(labelLoad(jobs, "hobo", NOW), {
			queued: 0,
			oldestWaitSeconds: 0,
			recentPickups: 2,
			slowestRecentPickupSeconds: 1500,
		});
	});

	// What happened: a probe was picked up at once, a run was sent to the
	// fleet on that, and its jobs waited 17 minutes for runners.
	it("holds a slow pickup against a label for longer than a pickup counts for it", () => {
		const jobs = [
			taken("hobo", 1020, RECENT_PICKUP_SECONDS + 600),
			taken("hobo", 3, 30),
		];
		const load = labelLoad(jobs, "hobo", NOW);
		assert.deepEqual(load, {
			queued: 0,
			oldestWaitSeconds: 0,
			recentPickups: 1,
			slowestRecentPickupSeconds: 1020,
		});
		assert.equal(takingJobs(load, limits), false);
		// Once the slow pickup is past the memory, the quick one stands alone.
		const later = NOW + SLOW_PICKUP_MEMORY_SECONDS * 1000;
		assert.equal(
			labelLoad(
				[
					...jobs,
					{
						...taken("hobo", 2, 0),
						createdAtMs: later - 2000,
						startedAtMs: later,
					},
				],
				"hobo",
				later,
			).slowestRecentPickupSeconds,
			2,
		);
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
		assert.match(
			routed.reason,
			/in the last 60 minutes took up to 1500 s to pick a job up/,
		);
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
	it("is the committed trunk label for trunk events, the fleet label otherwise", () => {
		assert.equal(fleetLabelFor("pull_request"), "hobo");
		assert.equal(fleetLabelFor("schedule"), "hobo");
		assert.equal(fleetLabelFor("merge_group"), "hobo-trunk");
		assert.equal(fleetLabelFor("push"), "hobo-trunk");
		const labels = {
			...DEFAULT_RUNNER_LABELS,
			fleet: "acme",
			trunk: "acme-trunk",
		};
		assert.equal(fleetLabelFor("push", labels), "acme-trunk");
		assert.equal(fleetLabelFor("pull_request", labels), "acme");
	});
});

describe("the run's slip class", () => {
	const pullRequest = (head: string | null, base: string) => ({
		pull_request: {
			head: { repo: head === null ? null : { full_name: head } },
			base: { repo: { full_name: base } },
		},
	});
	it("is trunk for trunk events, fork for another repository's pull request, else pr", () => {
		for (const event of TRUNK_EVENTS)
			assert.equal(routeClass(event, undefined), "trunk", event);
		assert.equal(
			routeClass(
				"pull_request",
				pullRequest("Hobo-Labs/HoBo", "hobo-labs/hobo"),
			),
			"pr",
		);
		assert.equal(
			routeClass("pull_request", pullRequest("someone/HoBo", "Hobo-Labs/HoBo")),
			"fork",
		);
		// A fork whose repository was deleted is still not this repository.
		assert.equal(
			routeClass("pull_request", pullRequest(null, "Hobo-Labs/HoBo")),
			"fork",
		);
		assert.equal(routeClass("schedule", undefined), "pr");
		assert.equal(routeClass("pull_request", undefined), "pr");
	});
});

describe("what this run chose, as arguments", () => {
	it("reads --route, --include-own-run and --attested, in either form", () => {
		assert.deepEqual(parseRouteArgs([]), {
			route: "auto",
			includeOwnRun: false,
			attested: false,
		});
		assert.deepEqual(
			parseRouteArgs([
				"--route",
				"github",
				"--include-own-run=true",
				"--attested",
				"true",
			]),
			{ route: "github", includeOwnRun: true, attested: true },
		);
		assert.equal(parseRouteArgs(["--route", "hosted"]).route, "auto");
		assert.equal(parseRouteArgs(["--attested", "yes"]).attested, false);
	});
	it("refuses anything else, so the action's fallback says the script did not run", () => {
		assert.throws(
			() => parseRouteArgs(["--mode", "fleet"]),
			/unknown argument/,
		);
		assert.throws(() => parseRouteArgs(["--route"]), /needs a value/);
	});
});

/** The routing slip fixtures `packages/ci-gh-actions` holds valid. */
const slipFixture = (name: string): JsonValue =>
	JSON.parse(
		readFileSync(
			new URL(
				`../../packages/ci-gh-actions/data-models/fixtures/valid/${name}`,
				import.meta.url,
			),
			"utf8",
		),
	);
/** A minute after the fixtures' slips were issued: they are current. */
const SLIP_NOW = Date.parse("2026-11-13T16:01:00.000Z");
const OPEN_SLIP = JSON.stringify(slipFixture("routing-slip.json"));
const REFUSED_SLIP = JSON.stringify(slipFixture("routing-slip-refused.json"));
const SLIP_SHA = "5".repeat(40);
/**
 * GitHub's Git API with the slip's commit behind `refs/hobo/routing-slip`, or
 * no such ref when `message` is undefined. Records every URL it was asked.
 */
const slipApi =
	(
		message: string | undefined,
		asked: string[] = [],
		headers: Headers[] = [],
	): typeof fetch =>
	async (url, init) => {
		asked.push(String(url));
		headers.push(new Headers(init?.headers));
		if (String(url).endsWith("/git/ref/hobo/routing-slip"))
			return message === undefined
				? Response.json({ message: "Not Found" }, { status: 404 })
				: Response.json({
						ref: "refs/hobo/routing-slip",
						object: { type: "commit", sha: SLIP_SHA },
					});
		if (String(url).endsWith(`/git/commits/${SLIP_SHA}`))
			return Response.json({ sha: SLIP_SHA, message });
		return Response.json({ message: "unexpected" }, { status: 500 });
	};
const COMMITTED = readFileSync(
	new URL("../../.hobo/ci.json", import.meta.url),
	"utf8",
);
/** `.hobo/ci.json` with its `runnerRouting` changed. */
const withRouting = (
	change: (
		routing: { -readonly [K in keyof RunnerRouting]: RunnerRouting[K] },
	) => void,
) => {
	const project = JSON.parse(COMMITTED);
	change(project.runnerRouting);
	return JSON.stringify(project);
};

describe("the routing slip", () => {
	const ask = (
		message: string | undefined,
		routeClassName: "pr" | "fork" | "trunk" = "pr",
		overrides: { repository?: string; nowMs?: number } = {},
	) =>
		askSlip({
			apiUrl: "https://api.github.test/",
			repository: overrides.repository ?? "Hobo-Labs/HoBo",
			token: "job-token",
			labels: DEFAULT_RUNNER_LABELS,
			routeClass: routeClassName,
			nowMs: () => overrides.nowMs ?? SLIP_NOW,
			fetch: slipApi(message),
		});

	it("decides the run's class, and says whose slip it was", async () => {
		const open = await ask(OPEN_SLIP, "trunk");
		assert.ok(open.ok);
		assert.deepEqual(open.decision, {
			tier: "fleet",
			runner: "hobo-trunk",
			reason: "relay: slip from oracle-box-1@c7ec8d449, fleet-busy",
			refusedBy: "none",
			slip: {
				kind: "used",
				reason: "fleet-busy",
				from: "oracle-box-1@c7ec8d449",
			},
		});
		const refused = await ask(REFUSED_SLIP, "trunk");
		assert.ok(refused.ok);
		assert.deepEqual(
			[
				refused.decision.tier,
				refused.decision.runner,
				refused.decision.refusedBy,
			],
			["github", "ubuntu-24.04", "slip"],
		);
		assert.match(refused.decision.reason, /, stalled$/);
	});

	it("sends a fork pull request by its own class, never the trunk one", async () => {
		const fork = await ask(REFUSED_SLIP, "fork");
		assert.ok(fork.ok);
		assert.deepEqual(
			[fork.decision.runner, fork.decision.slip],
			[
				"ubuntu-24.04",
				{
					kind: "used",
					reason: "no-node",
					from: "oracle-box-1@fa092c44f0a1b2c3d4e5f60718293a4b5c6d7e8f",
				},
			],
		);
		const pr = await ask(REFUSED_SLIP, "pr");
		assert.ok(pr.ok);
		assert.deepEqual(
			[pr.decision.tier, pr.decision.runner],
			["local", "hobo-local-host"],
		);
	});

	it("is read with two GET calls and the job's own token, and none at all when absent", async () => {
		const asked: string[] = [];
		const headers: Headers[] = [];
		await askSlip({
			apiUrl: "https://api.github.test",
			repository: "Hobo-Labs/HoBo",
			token: "job-token",
			labels: DEFAULT_RUNNER_LABELS,
			routeClass: "pr",
			nowMs: () => SLIP_NOW,
			fetch: slipApi(OPEN_SLIP, asked, headers),
		});
		assert.deepEqual(asked, [
			"https://api.github.test/repos/Hobo-Labs/HoBo/git/ref/hobo/routing-slip",
			`https://api.github.test/repos/Hobo-Labs/HoBo/git/commits/${SLIP_SHA}`,
		]);
		for (const header of headers)
			assert.equal(header.get("authorization"), "Bearer job-token");
		assert.deepEqual(await ask(undefined), {
			ok: false,
			why: NO_ROUTING_SLIP,
		});
	});

	it("is never used expired, for another repository, naming a label the policy does not allow, or malformed", async () => {
		/** The fields of the slip's wire record these cases change. */
		type SlipRecord = {
			version: number;
			extra?: boolean;
			classes: { pr: { runner: string; tier: string; reason: string } };
		};
		const slip = (change: (record: SlipRecord) => void) => {
			const record = JSON.parse(OPEN_SLIP);
			change(record);
			return JSON.stringify(record);
		};
		assert.deepEqual(
			await ask(OPEN_SLIP, "pr", { nowMs: SLIP_NOW + 600_000 }),
			{
				ok: false,
				why: "slip expired",
			},
		);
		assert.deepEqual(await ask(OPEN_SLIP, "pr", { repository: "acme/app" }), {
			ok: false,
			why: "slip names another repository",
		});
		assert.deepEqual(
			await ask(
				slip((record) => {
					record.classes.pr = {
						runner: "attacker-box",
						tier: "fleet",
						reason: "fleet-open",
					};
				}),
			),
			{ ok: false, why: "slip names a label not in runnerRouting.labels" },
		);
		for (const message of [
			"not json",
			slip((record) => {
				record.version = 2;
			}),
			slip((record) => {
				record.extra = true;
			}),
		])
			assert.deepEqual(await ask(message), {
				ok: false,
				why: "slip malformed",
			});
	});

	it("reads an API failure as no slip, and says which", async () => {
		const failing: typeof fetch = async () =>
			Response.json({ message: "boom" }, { status: 502 });
		assert.deepEqual(
			await askSlip({
				apiUrl: "https://api.github.test",
				repository: "Hobo-Labs/HoBo",
				token: "",
				labels: DEFAULT_RUNNER_LABELS,
				routeClass: "pr",
				nowMs: () => SLIP_NOW,
				fetch: failing,
			}),
			{ ok: false, why: "the routing slip could not be read (HTTP 502)" },
		);
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

	it("picks the finished runs that took longest, within the slow-pickup memory", () => {
		const finished = (id: number, started: number, ended: number) => ({
			id,
			status: "completed",
			created_at: at(started),
			updated_at: at(ended),
		});
		const page = {
			workflow_runs: [
				finished(1, 600, 120), // 8 minutes
				finished(2, 2400, 300), // 35 minutes: a run something held up
				finished(3, 700, 100), // 10 minutes
				finished(4, 900, 60), // 14 minutes
				finished(5, 500, 400), // short
				// Finished before the memory began, however long it took.
				finished(
					6,
					3 * SLOW_PICKUP_MEMORY_SECONDS,
					SLOW_PICKUP_MEMORY_SECONDS + 5,
				),
				{ ...finished(7, 5000, 10), path: PROBE_WORKFLOW_PATH },
				{
					id: 8,
					status: "in_progress",
					created_at: at(4000),
					updated_at: at(5),
				},
				{ id: 9, status: "completed", created_at: at(4000) },
			],
		};
		assert.equal(MAX_FINISHED_LOOKUPS, 3);
		assert.deepEqual(slowestFinishedRunIds(page, 99, NOW), [2, 4, 3]);
		assert.deepEqual(slowestFinishedRunIds(page, 2, NOW), [4, 3, 1]);
		assert.deepEqual(
			slowestFinishedRunIds({ message: "Not Found" }, 1, NOW),
			[],
		);
	});

	it("finds a slow pickup in a run that has already finished", async () => {
		const read: number[] = [];
		const view = await observeQueue({
			read: async (path) => {
				const runId = Number(/runs\/(\d+)\/jobs/.exec(path)?.[1]);
				if (Number.isNaN(runId))
					return {
						workflow_runs: [
							{
								id: 20,
								status: "completed",
								created_at: at(2400),
								updated_at: at(600),
							},
							{ id: 30, status: "completed", path: PROBE_WORKFLOW_PATH },
						],
					};
				read.push(runId);
				// The probe was taken at once; the real run's job waited 17 minutes.
				const waited = runId === 30 ? 3 : 1020;
				const ago = runId === 30 ? 30 : 1200;
				return {
					jobs: [
						{
							run_id: runId,
							status: "completed",
							labels: ["hobo"],
							runner_name: "hobo-1",
							created_at: at(ago + waited),
							started_at: at(ago),
						},
					],
				};
			},
			repository: "acme/app",
			ownRunId: 40,
			labels: ["hobo"],
			limits,
			nowMs: NOW,
		});
		assert.deepEqual(read, [30, 20]);
		const load = labelLoad(view.jobs, "hobo", NOW);
		assert.equal(load.recentPickups, 1);
		assert.equal(load.slowestRecentPickupSeconds, 1020);
		assert.equal(takingJobs(load, limits), false);
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
		overrides: {
			localEnrolled?: boolean;
		} = {},
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

/** GitHub's REST API on a local port, answering each path from `answer`. */
const withGithub = async <T>(
	answer: (path: string) => JsonValue,
	run: (apiUrl: string) => Promise<T>,
) => {
	const server = createServer((request, response) => {
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify(answer(request.url ?? "")));
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	// SAFETY: a server listening on a TCP port reports an AddressInfo.
	const { port } = server.address() as AddressInfo;
	try {
		return await run(`http://127.0.0.1:${port}`);
	} finally {
		await new Promise((done) => server.close(done));
	}
};

/** No routing slip: the relay has written none. */
const NO_SLIP = { routingConfig: COMMITTED, fetch: slipApi(undefined) };
/** A slip must not be read here: a pinned or attested run decides without it. */
const NO_SLIP_CALL = {
	routingConfig: COMMITTED,
	fetch: async (): Promise<never> => {
		throw new Error("the slip must not be read here");
	},
};

/** The lines the script printed, and its decision. */
const printedBy = async (
	run: () => Promise<RouteDecision>,
): Promise<{ decision: RouteDecision; lines: string[] }> => {
	const lines: string[] = [];
	const log = console.log;
	console.log = (...parts: unknown[]) => {
		lines.push(parts.map(String).join(" "));
	};
	try {
		return { decision: await run(), lines };
	} finally {
		console.log = log;
	}
};
const noticesIn = (lines: readonly string[]) =>
	lines.filter((line) => line.startsWith("::notice title=hobo-ci-route::"));
const warningsIn = (lines: readonly string[]) =>
	lines.filter((line) =>
		line.startsWith("::warning title=hobo-ci-route-fallback::"),
	);
/** The `hobo-ci-route` notice a decision should print, field by field. */
const notice = (fields: {
	workflow?: string;
	tier: string;
	runner: string;
	slip: string;
	why: string;
	refusedBy: string;
}) =>
	`::notice title=hobo-ci-route::${JSON.stringify({
		v: 2,
		workflow: fields.workflow ?? "",
		tier: fields.tier,
		runner: fields.runner,
		slip: fields.slip,
		why: fields.why,
		refusedBy: fields.refusedBy,
	})}`;

describe("the committed routing policy the route job reads", () => {
	it("holds the code's defaults, so moving them out of variables changed nothing", () => {
		const { committed, ...fromFile } = routeSettings(
			readRunnerRouting(COMMITTED),
		);
		const { committed: fromCode, ...defaults } = routeSettings(undefined);
		assert.deepEqual([committed, fromCode], [true, false]);
		assert.deepEqual(fromFile, defaults);
		assert.equal(defaults.localRunner, DEFAULT_LOCAL_RUNNER);
	});

	it("counts no slip and an expired slip as absent, every other refusal as unusable", () => {
		assert.deepEqual(ABSENT_SLIP_WHYS, [
			NO_ROUTING_SLIP,
			SLIP_REFUSAL_WHY.expired,
		]);
	});
});

describe("the script as a whole", () => {
	it("uses GitHub-hosted, and says why, when there is no slip and the queue cannot be read", async () => {
		const { decision, lines } = await printedBy(() =>
			main(
				[],
				{
					GITHUB_EVENT_NAME: "merge_group",
					GITHUB_REPOSITORY: "acme/app",
					GITHUB_RUN_ID: "1",
					GITHUB_API_URL: "http://127.0.0.1:9",
				},
				NO_SLIP,
			),
		);
		assert.equal(decision.runner, "ubuntu-24.04");
		assert.equal(decision.tier, "github");
		assert.match(decision.reason, /could not be read/);
		assert.deepEqual(warningsIn(lines), [
			"::warning title=hobo-ci-route-fallback::routing slip not used (no routing slip); the queue rule decides",
		]);
	});

	it("does not read the slip or the queue for a tier pinned by argument", async () => {
		const pinned = await main(
			["--route", "fleet"],
			{
				GITHUB_EVENT_NAME: "merge_group",
				GITHUB_API_URL: "http://127.0.0.1:9",
			},
			NO_SLIP_CALL,
		);
		assert.equal(pinned.runner, "hobo-trunk");
		const hosted = await main(
			["--route=github"],
			{
				GITHUB_EVENT_NAME: "pull_request",
				GITHUB_API_URL: "http://127.0.0.1:9",
			},
			NO_SLIP_CALL,
		);
		assert.equal(hosted.runner, "ubuntu-24.04");
		const fleet = await main(
			["--route", "fleet"],
			{
				GITHUB_EVENT_NAME: "pull_request",
				GITHUB_REPOSITORY: "acme/app",
				GITHUB_API_URL: "http://127.0.0.1:9",
			},
			NO_SLIP_CALL,
		);
		assert.deepEqual([fleet.tier, fleet.runner], ["fleet", "hobo"]);
	});

	it("follows the committed pin and labels, and a dispatch's own choice over them", async () => {
		const env = {
			GITHUB_EVENT_NAME: "push",
			GITHUB_API_URL: "http://127.0.0.1:9",
		};
		const pinnedLocal = withRouting((routing) => {
			routing.pin = "local";
			routing.labels = {
				fleet: "acme",
				trunk: "acme-trunk",
				local: "acme-local",
				github: "ubuntu-24.04",
			};
		});
		const local = await main([], env, {
			...NO_SLIP_CALL,
			routingConfig: pinnedLocal,
		});
		assert.deepEqual([local.tier, local.runner], ["local", "acme-local"]);
		const dispatched = await main(["--route", "fleet"], env, {
			...NO_SLIP_CALL,
			routingConfig: pinnedLocal,
		});
		assert.deepEqual(
			[dispatched.tier, dispatched.runner],
			["fleet", "acme-trunk"],
		);
	});

	it("uses the code's defaults, and says so, when .hobo/ci.json has no runnerRouting", async () => {
		const decision = await main(
			["--route", "fleet"],
			{ GITHUB_EVENT_NAME: "push" },
			{ ...NO_SLIP_CALL, routingConfig: "{}" },
		);
		assert.equal(decision.runner, "hobo-trunk");
		assert.match(
			decision.reason,
			/\.hobo\/ci\.json holds no valid runnerRouting, so the code's defaults apply/,
		);
	});

	it("sends what is left of an attested run to GitHub-hosted without reading the slip or the queue", async () => {
		const attested = await main(
			["--attested", "true"],
			{
				GITHUB_EVENT_NAME: "merge_group",
				GITHUB_API_URL: "http://127.0.0.1:9",
			},
			NO_SLIP_CALL,
		);
		assert.equal(attested.runner, "ubuntu-24.04");
		assert.equal(attested.tier, "github");
		assert.match(attested.reason, /signed local run/);
		// A pin is an operator's override: it still wins.
		const pinned = await main(
			["--attested", "true", "--route", "fleet"],
			{
				GITHUB_EVENT_NAME: "merge_group",
				GITHUB_API_URL: "http://127.0.0.1:9",
			},
			NO_SLIP_CALL,
		);
		assert.equal(pinned.runner, "hobo-trunk");
		// Anything but the literal `true` is not an attestation.
		const unattested = await main(
			["--attested", "false"],
			{
				GITHUB_EVENT_NAME: "pull_request",
				GITHUB_REPOSITORY: "acme/app",
				GITHUB_RUN_ID: "1",
				GITHUB_API_URL: "http://127.0.0.1:9",
			},
			NO_SLIP,
		);
		assert.match(unattested.reason, /could not be read/);
	});

	it("writes runner, tier and shard_runner as step outputs", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-route-output-"));
		try {
			const output = join(dir, "output");
			writeFileSync(output, "");
			await main(
				["--route", "fleet"],
				{ GITHUB_EVENT_NAME: "push", GITHUB_OUTPUT: output },
				NO_SLIP_CALL,
			);
			assert.equal(
				readFileSync(output, "utf8"),
				"runner=hobo-trunk\ntier=fleet\nshard_runner=hobo-trunk\n",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("the script reading the slip", () => {
	/** GitHub's queue with a runner that took the probe's `hobo` job a minute ago. */
	const fleetUpPages = (path: string): JsonValue => {
		const ago = (seconds: number) =>
			new Date(SLIP_NOW - seconds * 1000).toISOString();
		return path.includes("/jobs")
			? {
					jobs: [
						{
							run_id: 40,
							status: "completed",
							labels: ["hobo"],
							runner_name: "hobo-1",
							created_at: ago(65),
							started_at: ago(60),
						},
					],
				}
			: {
					workflow_runs: [
						{
							id: 40,
							path: PROBE_WORKFLOW_PATH,
							status: "completed",
							created_at: ago(65),
							updated_at: ago(50),
						},
					],
				};
	};
	const route = (
		apiUrl: string,
		message: string | undefined,
		env: Record<string, string> = {},
		argv: string[] = [],
	) =>
		printedBy(() =>
			main(
				argv,
				{
					GITHUB_EVENT_NAME: "pull_request",
					GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
					GITHUB_RUN_ID: "51",
					GITHUB_API_URL: apiUrl,
					...env,
				},
				{
					routingConfig: COMMITTED,
					eventPayload: undefined,
					fetch: slipApi(message),
					now: () => SLIP_NOW,
				},
			),
		);

	it("lets a usable slip decide without reading the queue", async () => {
		// The queue cannot be read here: only the slip can have decided.
		const { decision, lines } = await route("http://127.0.0.1:9", REFUSED_SLIP);
		assert.deepEqual(
			[decision.tier, decision.runner, decision.refusedBy],
			["local", "hobo-local-host", "slip"],
		);
		assert.match(
			decision.reason,
			/^relay: slip from oracle-box-1@fa092c44f\w*, no-capacity$/,
		);
		assert.deepEqual(warningsIn(lines), []);
		assert.deepEqual(noticesIn(lines), [
			notice({
				tier: "local",
				runner: "hobo-local-host",
				slip: "used",
				why: "no-capacity",
				refusedBy: "slip",
			}),
		]);
	});

	it("keeps a busy fleet the slip names, whatever the queue shows (R4)", async () => {
		const { decision } = await route("http://127.0.0.1:9", OPEN_SLIP, {
			GITHUB_EVENT_NAME: "push",
		});
		assert.deepEqual(
			[decision.tier, decision.runner, decision.refusedBy],
			["fleet", "hobo-trunk", "none"],
		);
		assert.match(decision.reason, /fleet-busy/);
	});

	it("routes a fork pull request by the slip's fork class", async () => {
		const { decision } = await printedBy(() =>
			main(
				[],
				{
					GITHUB_EVENT_NAME: "pull_request",
					GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
					GITHUB_API_URL: "http://127.0.0.1:9",
				},
				{
					routingConfig: COMMITTED,
					eventPayload: {
						pull_request: {
							head: { repo: { full_name: "someone/HoBo" } },
							base: { repo: { full_name: "Hobo-Labs/HoBo" } },
						},
					},
					fetch: slipApi(REFUSED_SLIP),
					now: () => SLIP_NOW,
				},
			),
		);
		assert.deepEqual(
			[decision.tier, decision.runner],
			["github", "ubuntu-24.04"],
		);
		assert.match(decision.reason, /no-node$/);
	});

	it("falls back to the queue at once, and says why, when no slip can be used", async () => {
		await withGithub(fleetUpPages, async (apiUrl) => {
			const expired = JSON.parse(OPEN_SLIP);
			expired.expiresAt = "2026-11-13T16:00:30.000Z";
			for (const [message, why] of [
				[undefined, "no routing slip"],
				[JSON.stringify(expired), "slip expired"],
				[
					OPEN_SLIP.replace('"hobo-trunk"', '"elsewhere"'),
					"slip names a label not in runnerRouting.labels",
				],
				["{}", "slip malformed"],
			] as const) {
				const { decision, lines } = await route(apiUrl, message);
				// What the queue alone decides: the fleet took the probe a minute ago.
				assert.deepEqual(
					[decision.tier, decision.runner, decision.refusedBy],
					["fleet", "hobo", "none"],
					why,
				);
				assert.deepEqual(warningsIn(lines), [
					`::warning title=hobo-ci-route-fallback::routing slip not used (${why}); the queue rule decides`,
				]);
				assert.deepEqual(noticesIn(lines), [
					notice({
						tier: "fleet",
						runner: "hobo",
						slip: "fallback",
						why,
						refusedBy: "none",
					}),
				]);
			}
		});
	});

	it("takes nothing about routing from the environment", async () => {
		// What a repository variable or a worker once handed over the old way.
		await withGithub(fleetUpPages, async (apiUrl) => {
			const { decision } = await route(apiUrl, undefined, {
				HOBO_CI_ROUTE: "github",
				HOBO_CI_LOCAL_RUNNER: "true",
				HOBO_CI_TRUNK_RUNNER: "false",
				HOBO_CI_ROUTE_MAX_WAIT_SECONDS: "1",
				HOBO_CI_ROUTE_MAX_QUEUED: "1",
				HOBO_CI_INCLUDE_OWN_RUN: "true",
				HOBO_CI_ATTESTED: "true",
				HOBO_CI_FLEET_STATE: JSON.stringify({
					labels: { hobo: { nodes: 0, freeSlots: 0 } },
				}),
			});
			assert.deepEqual([decision.tier, decision.runner], ["fleet", "hobo"]);
		});
		assert.doesNotMatch(
			readFileSync(new URL("../ci/route-runner.mts", import.meta.url), "utf8"),
			/env\.(HOBO_CI_|MAIN_WORKSPACE)/,
		);
	});

	it("annotates why no slip was read for a pinned or attested run", async () => {
		const env = {
			GITHUB_EVENT_NAME: "push",
			GITHUB_API_URL: "http://127.0.0.1:9",
			GITHUB_WORKFLOW_REF:
				"Hobo-Labs/HoBo/.github/workflows/hobo-ci.yml@refs/heads/main",
		};
		const unasked = (why: string) => [
			notice({
				workflow: "hobo-ci.yml",
				tier: "github",
				runner: "ubuntu-24.04",
				slip: "unasked",
				why,
				refusedBy: "none",
			}),
		];
		assert.deepEqual(
			noticesIn(
				(await printedBy(() => main(["--route", "github"], env, NO_SLIP_CALL)))
					.lines,
			),
			unasked("pinned"),
		);
		assert.deepEqual(
			noticesIn(
				(await printedBy(() => main(["--attested", "true"], env, NO_SLIP_CALL)))
					.lines,
			),
			unasked("attested"),
		);
		assert.deepEqual(
			noticesIn(
				(
					await printedBy(() =>
						main(
							[],
							{ ...env, GITHUB_REPOSITORY: "acme/app", GITHUB_RUN_ID: "1" },
							NO_SLIP,
						),
					)
				).lines,
			),
			[
				notice({
					workflow: "hobo-ci.yml",
					tier: "github",
					runner: "ubuntu-24.04",
					slip: "fallback",
					why: "no routing slip",
					refusedBy: "queue",
				}),
			],
		);
	});
});

describe("the route notice", () => {
	it("is one line a workflow command cannot cut short", () => {
		const line = routeAnnotation(
			{
				tier: "github",
				runner: "ubuntu-24.04",
				reason: "",
				refusedBy: "queue",
				slip: { kind: "fallback", why: "100% down\nnext" },
			},
			"hobo-ci.yml",
		);
		assert.doesNotMatch(line, /\n|\r/);
		assert.match(line, /^::notice title=hobo-ci-route::\{"v":2,/);
		assert.match(line, /100%25 down/);
		assert.match(line, /"refusedBy":"queue"/);
	});

	it("names the workflow file the run belongs to", () => {
		assert.equal(
			workflowFile({
				GITHUB_WORKFLOW_REF:
					"Hobo-Labs/HoBo/.github/workflows/pricing-ci.yml@refs/pull/7/merge",
			}),
			"pricing-ci.yml",
		);
		assert.equal(
			workflowFile({ GITHUB_WORKFLOW: "HoBo CI Fabric" }),
			"HoBo CI Fabric",
		);
	});
});

/**
 * Run 43354645076 (push fa092c44f, 2026-11-13; finding 0149) as the route
 * job saw it: the fleet had one trunk job waiting 356 s and had taken up to
 * 307 s to pick one up in the last hour; the hosted relay answered 503. The
 * queue refused the fleet and the run went to GitHub-hosted.
 */
describe("replaying the recorded production cases with no slip (M5)", () => {
	const at = (time: string) => `2026-11-13T${time}Z`;
	const NOW_149 = Date.parse(at("02:48:19"));
	const RUN = 43354645076;
	const pages = (path: string): JsonValue => {
		if (!path.includes("/jobs"))
			return {
				workflow_runs: [
					{
						id: RUN,
						status: "in_progress",
						created_at: at("02:48:05"),
						updated_at: at("02:48:11"),
					},
					{
						id: RUN - 9,
						status: "in_progress",
						created_at: at("02:30:00"),
						updated_at: at("02:42:23"),
					},
					{
						id: RUN - 30,
						path: PROBE_WORKFLOW_PATH,
						status: "completed",
						created_at: at("02:40:00"),
						updated_at: at("02:40:10"),
					},
				],
			};
		const runId = Number(/\/runs\/(\d+)\/jobs/.exec(path)?.[1]);
		// The running main run: a trunk job a runner took after 307 s, and one
		// still waiting since 02:42:23.
		if (runId === RUN - 9)
			return {
				jobs: [
					{
						run_id: runId,
						status: "completed",
						labels: ["hobo-trunk"],
						runner_name: "hobo-4c1d9e2a",
						created_at: at("02:20:00"),
						started_at: at("02:25:07"),
					},
					{
						run_id: runId,
						status: "queued",
						labels: ["hobo-trunk"],
						created_at: at("02:42:23"),
					},
				],
			};
		// The probe: a runner took the trunk label's job in 3 s.
		if (runId === RUN - 30)
			return {
				jobs: [
					{
						run_id: runId,
						status: "completed",
						labels: ["hobo-trunk"],
						runner_name: "hobo-runner-7x2kq",
						created_at: at("02:40:00"),
						started_at: at("02:40:03"),
					},
				],
			};
		return { jobs: [] };
	};

	it("sends the run to GitHub-hosted, refused by the queue, as production did", async () => {
		await withGithub(pages, async (apiUrl) => {
			const { decision } = await printedBy(() =>
				main(
					[],
					{
						GITHUB_EVENT_NAME: "push",
						GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
						GITHUB_RUN_ID: String(RUN),
						GITHUB_API_URL: apiUrl,
					},
					{ ...NO_SLIP, now: () => NOW_149 },
				),
			);
			// The notice production printed: tier github, ubuntu-24.04, refused by the queue.
			assert.deepEqual(
				[decision.tier, decision.runner, decision.refusedBy],
				["github", "ubuntu-24.04", "queue"],
			);
			assert.match(
				decision.reason,
				/^the fleet has 1 waiting, the oldest for 356 s, and in the last 60 minutes took up to 307 s to pick a job up; no local box is enrolled; the limits are 120 s and 4 waiting; no routing slip decided \(no routing slip\)$/,
			);
		});
	});

	it("keeps the fleet under committed limits that allow those waits, so the policy, not a variable, sets them", async () => {
		await withGithub(pages, async (apiUrl) => {
			const decision = await main(
				[],
				{
					GITHUB_EVENT_NAME: "push",
					GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
					GITHUB_RUN_ID: String(RUN),
					GITHUB_API_URL: apiUrl,
				},
				{
					fetch: slipApi(undefined),
					routingConfig: withRouting((routing) => {
						routing.queue = { maxWaitSeconds: 400, maxQueued: 4 };
					}),
					now: () => NOW_149,
				},
			);
			assert.deepEqual(
				[decision.tier, decision.runner],
				["fleet", "hobo-trunk"],
			);
		});
	});
});

/**
 * Run 43207388098 (finding 142) as it stood when its plan job started: the
 * box was refusing jobs for lack of memory, ARC took one job ten seconds
 * after it was queued, and the run's own plan job waited 444 s for a runner.
 */
describe("a second ask within a run", () => {
	const RUN = 43207388098;
	const PROBE_RUN = RUN - 500;
	const at = (time: string) => `2026-11-12T${time}Z`;
	const NOW_142 = Date.parse(at("11:21:50"));
	const runsPage = {
		workflow_runs: [
			{
				id: RUN,
				status: "in_progress",
				created_at: at("11:14:02"),
				updated_at: at("11:21:44"),
			},
			// The probe was picked up at once, so the label looked alive.
			{
				id: PROBE_RUN,
				path: PROBE_WORKFLOW_PATH,
				status: "completed",
				created_at: at("11:10:00"),
				updated_at: at("11:10:20"),
			},
		],
	};
	const jobsPages = new Map<number, JsonValue>([
		[
			RUN,
			{
				jobs: [
					{
						run_id: RUN,
						name: "Route runners",
						status: "completed",
						labels: ["ubuntu-24.04"],
						runner_name: "GitHub Actions 1000",
						created_at: at("11:14:02"),
						started_at: at("11:14:06"),
					},
					// Skipped: no image input changed.
					{
						run_id: RUN,
						name: "CI runner image (mise oci)",
						status: "completed",
						labels: ["hobo-trunk"],
						runner_name: "",
						created_at: at("11:14:20"),
						started_at: at("11:14:20"),
					},
					// ARC took it ten seconds after it was queued.
					{
						run_id: RUN,
						name: "CI deps layer (pnpm)",
						status: "completed",
						labels: ["hobo-trunk"],
						runner_name: "hobo-runner-7x2kq",
						created_at: at("11:14:20"),
						started_at: at("11:14:30"),
					},
					{
						run_id: RUN,
						name: "Main workspace plan",
						status: "in_progress",
						labels: ["hobo-trunk"],
						runner_name: "hobo-4c1d9e2a-0b7f-4c55-9a8e-2f6b1d0c3e11",
						created_at: at("11:14:20"),
						started_at: at("11:21:44"),
					},
				],
			},
		],
		[
			PROBE_RUN,
			{
				jobs: [
					{
						run_id: PROBE_RUN,
						status: "completed",
						labels: ["hobo-trunk"],
						runner_name: "hobo-runner-7x2kq",
						created_at: at("11:10:01"),
						started_at: at("11:10:04"),
					},
				],
			},
		],
	]);
	const read = async (path: string): Promise<JsonValue> => {
		if (!path.includes("/jobs")) return runsPage;
		const runId = Number(/\/runs\/(\d+)\/jobs/.exec(path)?.[1]);
		return jobsPages.get(runId) ?? { jobs: [] };
	};
	const reading = (includeOwnRun: boolean, paths: string[] = []) =>
		observeQueue({
			read: async (path) => {
				paths.push(path);
				return read(path);
			},
			repository: "Hobo-Labs/HoBo",
			ownRunId: RUN,
			labels: ["hobo-trunk"],
			limits,
			nowMs: NOW_142,
			includeOwnRun,
		});
	const decide = (includeOwnRun: boolean) =>
		chooseRunner({
			observe: () => reading(includeOwnRun),
			now: () => NOW_142,
			sleep: async () => undefined,
			mode: "auto",
			fleetLabel: "hobo-trunk",
			localEnrolled: false,
			limits,
		});

	it("replays finding 142: with include-own-run the plan job's wait sends the shards to GitHub-hosted", async () => {
		const reask = await decide(true);
		assert.deepEqual(
			[reask.tier, reask.runner, reask.refusedBy],
			["github", "ubuntu-24.04", "queue"],
		);
		assert.match(reask.reason, /took up to 444 s to pick a job up/);
		// The route job's reading, which leaves its own run out, kept the fleet.
		const first = await decide(false);
		assert.deepEqual([first.tier, first.runner], ["fleet", "hobo-trunk"]);
	});

	it("replays finding 142 through the script: --include-own-run with no slip sends the shards to GitHub-hosted", async () => {
		const page = (path: string): JsonValue => {
			if (!path.includes("/jobs")) return runsPage;
			const runId = Number(/\/runs\/(\d+)\/jobs/.exec(path)?.[1]);
			return jobsPages.get(runId) ?? { jobs: [] };
		};
		await withGithub(page, async (apiUrl) => {
			const env = {
				GITHUB_EVENT_NAME: "push",
				GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
				GITHUB_RUN_ID: String(RUN),
				GITHUB_API_URL: apiUrl,
			};
			const io = { ...NO_SLIP, now: () => NOW_142 };
			const { decision: reask } = await printedBy(() =>
				main(["--include-own-run", "true"], env, io),
			);
			assert.deepEqual(
				[reask.tier, reask.runner, reask.refusedBy],
				["github", "ubuntu-24.04", "queue"],
			);
			const { decision: first } = await printedBy(() => main([], env, io));
			assert.deepEqual([first.tier, first.runner], ["fleet", "hobo-trunk"]);
		});
	});

	it("reads this run's own jobs first, and only when asked to", async () => {
		const asked: string[] = [];
		await reading(true, asked);
		assert.equal(
			asked[1],
			`/repos/Hobo-Labs/HoBo/actions/runs/${RUN}/jobs?filter=latest&per_page=100`,
		);
		const left: string[] = [];
		await reading(false, left);
		assert.ok(left.every((path) => !path.includes(`/runs/${RUN}/`)));
	});
});

describe("the routing step without a decision", () => {
	const root = resolve(import.meta.dirname, "..", "..");
	/** The route step's shell script, as the action runs it. */
	const script = (() => {
		const lines = readFileSync(
			join(root, ".github/actions/route-runner/action.yml"),
			"utf8",
		).split("\n");
		const step = lines.indexOf("    - id: route");
		const run = lines.indexOf("      run: |", step);
		assert.ok(step > -1 && run > step);
		const body: string[] = [];
		for (const line of lines.slice(run + 1)) {
			if (line.trim() !== "" && !line.startsWith("        ")) break;
			body.push(line.slice(8));
		}
		return body.join("\n");
	})();
	/**
	 * Runs the step where the routing script was not checked out (finding 146),
	 * with the action's expressions already replaced as GitHub replaces them.
	 */
	const fallBack = (chosen: {
		route?: string;
		includeOwnRun?: string;
		attested?: string;
	}) => {
		const expressions = script
			.replace(/^route='\$\{\{.*\}\}'$/m, `route='${chosen.route ?? "auto"}'`)
			.replace(
				/^include_own_run='\$\{\{.*\}\}'$/m,
				`include_own_run='${chosen.includeOwnRun ?? "false"}'`,
			)
			.replace(
				/^attested='\$\{\{.*\}\}'$/m,
				`attested='${chosen.attested ?? "false"}'`,
			);
		assert.doesNotMatch(expressions, /\$\{\{/);
		const dir = mkdtempSync(join(tmpdir(), "hobo-route-fallback-"));
		try {
			const output = join(dir, "output");
			writeFileSync(output, "");
			const run = spawnSync("bash", ["-c", expressions], {
				cwd: dir,
				encoding: "utf8",
				env: {
					PATH: process.env.PATH ?? "",
					GITHUB_OUTPUT: output,
					GITHUB_EVENT_NAME: "push",
				},
			});
			assert.equal(run.status, 0, run.stderr);
			return { stdout: run.stdout, output: readFileSync(output, "utf8") };
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
	const WARNING =
		/^::warning title=hobo-ci-route-fallback::runner routing did not run \(the routing script failed\)/m;

	it("names the fallback in a titled warning, and uses GitHub-hosted", () => {
		const { stdout, output } = fallBack({});
		assert.match(stdout, WARNING);
		assert.equal(
			output,
			"runner=ubuntu-24.04\ntier=github\nshard_runner=ubuntu-24.04\n",
		);
	});

	it("names the fallback and keeps a pinned fleet on the fleet", () => {
		const { stdout, output } = fallBack({ route: "fleet" });
		assert.match(stdout, WARNING);
		assert.equal(
			output,
			"runner=hobo-trunk\ntier=fleet\nshard_runner=hobo-trunk\n",
		);
	});

	it("passes what the run chose to the script as arguments, never as environment", () => {
		assert.match(
			script,
			/scripts\/ci\/route-runner\.mts \\\n\s+--route "\$\{route\}" --include-own-run "\$\{include_own_run\}" --attested "\$\{attested\}"/,
		);
		// Only a fixed literal can come out of each expression.
		assert.ok(
			script.includes(
				`route='\${{ contains(fromJSON('["auto","fleet","local","github"]'), inputs.route) && inputs.route || 'auto' }}'`,
			),
		);
		assert.doesNotMatch(script, /HOBO_CI_/);
	});

	it("names the fallback and outputs nothing on a second ask, so the run's route stands", () => {
		const { stdout, output } = fallBack({ includeOwnRun: "true" });
		assert.match(stdout, WARNING);
		assert.match(stdout, /keeping the run's route/);
		assert.equal(output, "");
	});
});

describe("the workflows that route", () => {
	const root = resolve(import.meta.dirname, "..", "..");
	const read = (path: string) => readFileSync(join(root, path), "utf8");
	/** The files a script loads, itself included, as repository paths. */
	const loadedBy = (path: string, seen = new Set<string>()): Set<string> => {
		if (seen.has(path)) return seen;
		seen.add(path);
		for (const [, specifier = ""] of read(path).matchAll(
			/^(?:import|export)\s[^;]*?from\s+"([^"]+)"/gms,
		)) {
			if (specifier.startsWith("node:")) continue;
			assert.ok(
				specifier.startsWith("."),
				`${path} imports ${specifier}, which the route job never installs`,
			);
			loadedBy(
				relative(root, resolve(root, dirname(path), specifier)).replaceAll(
					"\\",
					"/",
				),
				seen,
			);
		}
		return seen;
	};
	const routed = readdirSync(join(root, ".github/workflows"))
		.map((name) => `.github/workflows/${name}`)
		.filter((path) =>
			read(path).includes("uses: ./.github/actions/route-runner"),
		);

	// A file the script loads and a workflow does not check out stops the
	// script before it decides, and the step then falls back to GitHub-hosted.
	it("check out every file the routing script loads", () => {
		const needed = loadedBy("scripts/ci/route-runner.mts");
		assert.deepEqual([...needed].sort(), [
			"packages/ci/src/fleet-overflow.ts",
			"scripts/ci/route-runner.mts",
			"scripts/ci/runner-routing.mts",
		]);
		assert.ok(routed.length >= 6, `found ${routed.length} routed workflows`);
		for (const path of routed) {
			const lines = new Set(
				read(path)
					.split("\n")
					.map((line) => line.trim()),
			);
			for (const file of needed)
				assert.ok(lines.has(file), `${path} does not sparse-checkout ${file}`);
		}
	});

	it("check out the committed routing policy", () => {
		for (const path of routed)
			assert.ok(
				read(path)
					.split("\n")
					.some((line) => line.trim() === RUNNER_ROUTING_PATH),
				`${path} does not sparse-checkout ${RUNNER_ROUTING_PATH}`,
			);
	});

	it("offer a dispatch's route as a choice", () => {
		const ci = read(".github/workflows/hobo-ci.yml");
		assert.match(
			ci,
			/ {6}route:\n {8}description: .*\n {8}type: choice\n {8}options: \[auto, fleet, local, github\]\n/,
		);
		assert.equal(ci.split("route: ${{ inputs.route || 'auto' }}").length, 3);
	});

	it("hand the routing step nothing about routing but what the run chose", () => {
		// The script reads the slip and runnerRouting at decision time; no
		// repository variable, input or environment variable carries them.
		const action = read(".github/actions/route-runner/action.yml");
		for (const path of [".github/actions/route-runner/action.yml", ...routed])
			assert.doesNotMatch(
				read(path),
				/fleet-state|fleet-capacity|vars\.HOBO_CI_|HOBO_CI_(ROUTE|TRUNK_RUNNER|LOCAL_RUNNER|INCLUDE_OWN_RUN|ATTESTED|FLEET_)|local-runner:|trunk-runner:|max-wait-seconds:|max-queued:/,
				path,
			);
		assert.match(action, /scripts\/ci\/route-runner\.mts/);
	});
});
