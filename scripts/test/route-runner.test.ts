import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
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
	AGENT37_OVERFLOW_RUNNER_LABEL,
	askSlip,
	BURST_SECONDS,
	chooseRunner,
	confirmMergeGroupFabricFleet,
	DEFAULT_LOCAL_RUNNER,
	DEFAULT_MAX_QUEUED,
	DEFAULT_MAX_WAIT_SECONDS,
	DEFAULT_RUNNER_LABELS,
	fleetLabelFor,
	fleetPoolRunners,
	HOBO_CI_NODE_CPU_PERCENT_VARIABLE,
	HOBO_POOL_CPU_SATURATED_ABOVE_PERCENT,
	hasChosen,
	hoboPoolSaturation,
	type JsonValue,
	type LabelLoad,
	labelLoad,
	lookupOrder,
	MAX_FINISHED_LOOKUPS,
	MAX_PROBE_LOOKUPS,
	MAX_RUN_LOOKUPS,
	main,
	mergeGroupTrunkHasIdleCapacity,
	NO_ROUTING_SLIP,
	observeQueue,
	PROBE_POLL_SECONDS,
	PROBE_WAIT_SECONDS,
	PROBE_WORKFLOW_PATH,
	type PrBatchCapacityVerifier,
	parseNodeCpuPercent,
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
	ROUTING_SLIP_READ_TIMEOUT_MS,
	RUNNER_ROUTING_PATH,
	type RunnerRouting,
	readRunnerRouting,
} from "../ci/runner-routing.mts";

const NOW = Date.parse("2026-11-10T18:00:00Z");
const SAME_REPOSITORY_PULL: JsonValue = {
	pull_request: {
		base: { repo: { full_name: "Hobo-Labs/HoBo" } },
		head: { repo: { full_name: "Hobo-Labs/HoBo" } },
	},
};
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
	it("requires matching pull-request repositories and fails closed without them", () => {
		for (const event of TRUNK_EVENTS)
			assert.equal(routeClass(event, undefined), "trunk", event);
		for (const event of [
			"pull_request",
			"pull_request_target",
			"merge_group",
		]) {
			assert.equal(
				routeClass(event, pullRequest("Hobo-Labs/HoBo", "hobo-labs/hobo")),
				"pr",
				event,
			);
			assert.equal(
				routeClass(event, pullRequest("someone/HoBo", "Hobo-Labs/HoBo")),
				"fork",
				event,
			);
			assert.equal(
				routeClass(event, pullRequest(null, "Hobo-Labs/HoBo")),
				"fork",
				event,
			);
		}
		assert.equal(routeClass("schedule", undefined), "fork");
		for (const event of ["pull_request", "pull_request_target"])
			for (const payload of [undefined, {}, { pull_request: {} }])
				assert.equal(routeClass(event, payload), "fork");
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

	it("adds at most the three-second limit when GitHub does not answer (M3)", async () => {
		// A GitHub API that never answers: only the read's own limit ends the wait.
		const hanging: typeof fetch = (_url, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(init.signal?.reason),
				);
			});
		const startedMs = performance.now();
		const reading = await askSlip({
			apiUrl: "https://api.github.test",
			repository: "Hobo-Labs/HoBo",
			token: "job-token",
			labels: DEFAULT_RUNNER_LABELS,
			routeClass: "pr",
			nowMs: () => SLIP_NOW,
			fetch: hanging,
		});
		const tookMs = performance.now() - startedMs;
		assert.deepEqual(reading, {
			ok: false,
			why: "the routing slip was not read in time",
		});
		assert.equal(ROUTING_SLIP_READ_TIMEOUT_MS, 3_000);
		assert.ok(tookMs < ROUTING_SLIP_READ_TIMEOUT_MS + 500, `took ${tookMs} ms`);
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

	it("can exhaust the bounded lookups after refusal without changing the default", async () => {
		const read = async (path: string): Promise<JsonValue> => {
			if (!path.includes("/jobs")) return runsPage;
			if (path.includes("/runs/40/"))
				return {
					jobs: [
						{
							run_id: 40,
							status: "completed",
							labels: ["self-hosted", "hobo"],
							runner_name: "runner",
							created_at: at(10),
							started_at: at(8),
						},
					],
				};
			return jobsPage(10, 4000);
		};
		const observe = (exhaustLookups: boolean) =>
			observeQueue({
				read,
				repository: "acme/app",
				ownRunId: 7,
				labels: ["hobo"],
				limits,
				nowMs: NOW,
				exhaustLookups,
			});
		assert.equal(
			(await observe(false)).jobs.some((job) => job.labels.length > 1),
			false,
		);
		assert.equal(
			(await observe(true)).jobs.some((job) => job.labels.length > 1),
			true,
		);
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
			{
				id: 50,
				status: "in_progress",
				created_at: at(5),
				path: ".github/workflows/hobo-ci.yml",
				head_sha: "50",
			},
			{
				id: 49,
				status: "queued",
				created_at: at(20),
				path: ".github/workflows/hobo-ci.yml",
				head_sha: "49",
			},
			{ id: 48, status: "queued", path: PROBE_WORKFLOW_PATH },
			{
				id: 47,
				status: "in_progress",
				created_at: at(BURST_SECONDS + 30),
				path: ".github/workflows/hobo-ci.yml",
				head_sha: "47",
			},
			{ id: 46, status: "completed", path: PROBE_WORKFLOW_PATH },
			{
				id: 45,
				status: "completed",
				created_at: at(10),
				path: ".github/workflows/hobo-ci.yml",
				head_sha: "45",
			},
			{ id: 44, status: "completed", path: PROBE_WORKFLOW_PATH },
			{ id: 43, status: "completed", path: PROBE_WORKFLOW_PATH },
			{
				id: 51,
				status: "queued",
				created_at: at(2),
				path: ".github/workflows/hobo-ci.yml",
				head_sha: "51",
			},
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

	it("leaves same-commit siblings and unrouted workflows out of the burst", () => {
		const own = {
			id: 50,
			status: "in_progress",
			created_at: at(0),
			path: ".github/workflows/hobo-ci.yml",
			head_sha: "S",
		};
		const siblings = (
			[
				[49, ".github/workflows/release-hobo.yml"],
				[48, ".github/workflows/actions-lock.yml"],
				[47, ".github/workflows/release-integration.yml"],
			] as const
		).map(([id, path], index) => ({
			id,
			status: "queued",
			created_at: at(index + 1),
			path,
			head_sha: "S",
		}));
		assert.deepEqual(
			runsJustAhead({ workflow_runs: [own, ...siblings] }, 50, NOW),
			[],
		);
		const otherCommit = {
			id: 46,
			status: "queued",
			created_at: at(4),
			path: ".github/workflows/hobo-ci.yml",
			head_sha: "T",
		};
		assert.deepEqual(
			runsJustAhead(
				{ workflow_runs: [own, ...siblings, otherCommit] },
				50,
				NOW,
			),
			[46],
		);
		assert.deepEqual(
			runsJustAhead(
				{
					workflow_runs: [
						own,
						{
							...otherCommit,
							path: ".github/workflows/app-credentials.yml",
						},
					],
				},
				50,
				NOW,
			),
			[],
		);
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
				path: ".github/workflows/hobo-ci.yml",
				head_sha: String(index),
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
/** A slip must not be read here: a pinned run decides without it. */
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
				box: "acme-box",
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

	it("honours a pin even when a local run was attested", async () => {
		const pinned = await main(
			["--attested", "true", "--route", "fleet"],
			{
				GITHUB_EVENT_NAME: "merge_group",
				GITHUB_API_URL: "http://127.0.0.1:9",
			},
			NO_SLIP_CALL,
		);
		assert.equal(pinned.runner, "hobo-trunk");
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
				"box_runner=\nrunner=hobo-trunk\ntier=fleet\nshard_runner=hobo-trunk\n",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("names the box label for the deps-image job only when committed boxRunner is on", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-route-box-"));
		try {
			const output = join(dir, "output");
			const run = async (config: string | undefined) => {
				writeFileSync(output, "");
				await main(
					["--route", "fleet"],
					{ GITHUB_EVENT_NAME: "pull_request", GITHUB_OUTPUT: output },
					{ ...NO_SLIP_CALL, routingConfig: config },
				);
				return readFileSync(output, "utf8").split("\n")[0];
			};
			// Today's behaviour: the committed policy and the code's default leave it off.
			assert.equal(await run(withRouting(() => {})), "box_runner=");
			assert.equal(await run("{}"), "box_runner=");
			assert.equal(
				await run(
					withRouting((routing) => {
						routing.boxRunner = true;
					}),
				),
				"box_runner=hobo-box",
			);
			assert.equal(
				await run(
					withRouting((routing) => {
						routing.boxRunner = true;
						routing.labels = { ...routing.labels, box: "acme-box" };
					}),
				),
				"box_runner=acme-box",
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
	const slipFromFixtureAndQueueFromServerFetch =
		(message: string | undefined): typeof fetch =>
		async (url, init) =>
			String(url).includes("/git/")
				? slipApi(message)(url, init)
				: fetch(url, init);
	const route = (
		apiUrl: string,
		message: string | undefined,
		env: Record<string, string> = {},
		argv: string[] = [],
		routingConfig = COMMITTED,
		verifyPrBatchCapacity?: PrBatchCapacityVerifier,
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
					routingConfig,
					eventPayload:
						env.GITHUB_EVENT_NAME === "push" ? undefined : SAME_REPOSITORY_PULL,
					fetch: slipFromFixtureAndQueueFromServerFetch(message),
					now: () => SLIP_NOW,
					verifyPrBatchCapacity,
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

	it("routes the remaining jobs by the slip or queue even when local evidence exists", async () => {
		const fromSlip = await route("http://127.0.0.1:9", REFUSED_SLIP, {}, [
			"--attested",
			"true",
		]);
		assert.deepEqual(
			[fromSlip.decision.tier, fromSlip.decision.runner],
			["local", "hobo-local-host"],
		);
		await withGithub(fleetUpPages, async (apiUrl) => {
			const fromQueue = await route(apiUrl, undefined, {}, [
				"--attested",
				"true",
			]);
			assert.deepEqual(
				[fromQueue.decision.tier, fromQueue.decision.runner],
				["fleet", "hobo"],
			);
		});
	});

	/** A finished probe and the actual jobs observed for the requested labels. */
	const observed =
		(jobs: JsonValue[]) =>
		(path: string): JsonValue =>
			path.includes("/jobs")
				? { jobs }
				: {
						workflow_runs: [
							{
								id: 40,
								path: PROBE_WORKFLOW_PATH,
								status: "completed",
								created_at: new Date(SLIP_NOW - 70_000).toISOString(),
								updated_at: new Date(SLIP_NOW - 50_000).toISOString(),
							},
						],
					};
	const pickup = (label: string) => ({
		run_id: 40,
		status: "completed",
		labels: [label],
		runner_name: "runner-1",
		created_at: new Date(SLIP_NOW - 65_000).toISOString(),
		started_at: new Date(SLIP_NOW - 60_000).toISOString(),
	});
	const waiting = (label: string, seconds: number) => ({
		run_id: 40,
		status: "queued",
		labels: [label],
		created_at: new Date(SLIP_NOW - seconds * 1000).toISOString(),
	});
	const mergeGroupIdentity = {
		GITHUB_REPOSITORY_ID: "1274791462",
		GITHUB_REPOSITORY_OWNER_ID: "344805935",
		GITHUB_RUN_ATTEMPT: "1",
		GITHUB_SHA: "d".repeat(40),
	};
	const mergeGroupCi = {
		...mergeGroupIdentity,
		GITHUB_EVENT_NAME: "merge_group",
		GITHUB_WORKFLOW_REF:
			"Hobo-Labs/HoBo/.github/workflows/hobo-ci.yml@refs/heads/gh-readonly-queue/main",
		GITHUB_TOKEN: "token",
	};
	const mergeGroupRelease = {
		...mergeGroupIdentity,
		GITHUB_EVENT_NAME: "merge_group",
		GITHUB_WORKFLOW_REF:
			"Hobo-Labs/HoBo/.github/workflows/release-hobo.yml@refs/heads/gh-readonly-queue/main",
		GITHUB_TOKEN: "token",
	};

	it("requires positive trunk pickup evidence before calling capacity idle", () => {
		assert.equal(mergeGroupTrunkHasIdleCapacity(idle), false);
		assert.equal(mergeGroupTrunkHasIdleCapacity(up), true);
		assert.equal(mergeGroupTrunkHasIdleCapacity({ ...up, queued: 1 }), false);
	});

	it("falls back to GitHub-hosted when the merge-group Fabric probe is unreadable", async () => {
		const { decision, lines } = await printedBy(() =>
			main(
				[],
				{
					...mergeGroupCi,
					GITHUB_API_URL: "https://api.github.com",
					GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
					GITHUB_REPOSITORY_ID: "1274791462",
					GITHUB_REPOSITORY_OWNER_ID: "344805935",
				},
				{
					routingConfig: COMMITTED,
					fetch: async (url) =>
						publicRepoRead(url) ?? new Response(null, { status: 503 }),
				},
			),
		);
		assert.deepEqual(
			[decision.tier, decision.runner, decision.refusedBy],
			["github", "ubuntu-24.04", "queue"],
		);
		assert.match(
			decision.reason,
			/merge-group Fabric queue probe is unreadable/u,
		);
		assert.match(lines.join("\n"), /hobo-ci-route-fallback/);
	});

	it("treats one queued hosted job as no merge-group hosted capacity", async () => {
		await withGithub(
			observed([waiting("ubuntu-24.04", 2), pickup("hobo-trunk")]),
			async (apiUrl) => {
				const { decision, lines } = await route(
					apiUrl,
					undefined,
					mergeGroupCi,
					[],
					COMMITTED,
					async (scope) => {
						assert.equal(scope.runner, "hobo-trunk");
						return true;
					},
				);
				assert.equal(decision.tier, "fleet");
				assert.equal(decision.runner, "hobo-trunk");
				assert.equal(decision.mergeGroupHostedProbe?.idle, false);
				assert.match(
					lines.join("\n"),
					/merge-group hosted probe:.*idle=false/u,
				);
			},
		);
	});

	it("reads the merge-group Fabric queue through the caller's fetch, not io.fetch", async () => {
		const queueFetch: typeof fetch = async (url) => {
			const path = String(url);
			if (path.includes("/git/"))
				return Response.json({ message: "Not Found" }, { status: 404 });
			if (path.includes("/jobs"))
				return Response.json({
					jobs: [...saturatedHostedQueue(), pickup("hobo-trunk")],
				});
			return Response.json({
				workflow_runs: [
					{
						id: 40,
						path: ".github/workflows/hobo-ci.yml",
						status: "in_progress",
						created_at: new Date(SLIP_NOW - 10_000).toISOString(),
						updated_at: new Date(SLIP_NOW - 10_000).toISOString(),
					},
				],
			});
		};
		const { decision } = await printedBy(() =>
			main(
				[],
				{
					...mergeGroupCi,
					GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
					GITHUB_RUN_ID: "51",
					GITHUB_API_URL: "https://api.example.invalid",
				},
				{
					routingConfig: COMMITTED,
					eventPayload: SAME_REPOSITORY_PULL,
					fetch: queueFetch,
					now: () => SLIP_NOW,
					verifyPrBatchCapacity: async () => true,
				},
			),
		);
		assert.deepEqual(
			[decision.tier, decision.runner, decision.refusedBy],
			["fleet", "hobo-trunk", "none"],
		);
		assert.deepEqual(decision.slip, { kind: "unasked", why: "merge-group" });
	});

	const saturatedHostedQueue = () =>
		Array.from({ length: 5 }, (_, index) =>
			waiting("ubuntu-24.04", 10 + index),
		);

	const prBatchCi = {
		GITHUB_EVENT_NAME: "pull_request",
		GITHUB_WORKFLOW_REF:
			"Hobo-Labs/HoBo/.github/workflows/hobo-ci.yml@refs/pull/1/merge",
		GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
		GITHUB_REPOSITORY_ID: "1274791462",
		GITHUB_REPOSITORY_OWNER_ID: "344805935",
		GITHUB_RUN_ID: "51",
		GITHUB_TOKEN: "token",
	};
	const forkPull: JsonValue = {
		pull_request: {
			base: { repo: { full_name: "Hobo-Labs/HoBo" } },
			head: { repo: { full_name: "someone/HoBo" } },
		},
	};
	const publicRepoRead = (url: RequestInfo | URL): Response | undefined =>
		String(url) === "https://api.github.com/repos/Hobo-Labs/HoBo"
			? Response.json({
					id: 1274791462,
					owner: { id: 344805935 },
					private: false,
					visibility: "public",
					disabled: false,
					archived: false,
				})
			: undefined;
	const mergeGroupRoute = (
		answer: (path: string) => JsonValue,
		verifyPrBatchCapacity: PrBatchCapacityVerifier = async () => true,
	) =>
		printedBy(() =>
			main(
				[],
				{
					...mergeGroupCi,
					GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
					GITHUB_RUN_ID: "50",
					GITHUB_API_URL: "https://api.github.com",
				},
				{
					routingConfig: COMMITTED,
					eventPayload: SAME_REPOSITORY_PULL,
					fetch: async (url) =>
						publicRepoRead(url) ??
						Response.json(
							answer(String(url).replace("https://api.github.com", "")),
						),
					now: () => SLIP_NOW,
					verifyPrBatchCapacity,
				},
			),
		);
	const recentPickup = (label: string, waited = 1, ago = 60) => ({
		run_id: 40,
		status: "completed",
		labels: [label],
		runner_name: "runner-1",
		created_at: new Date(SLIP_NOW - (ago + waited) * 1000).toISOString(),
		started_at: new Date(SLIP_NOW - ago * 1000).toISOString(),
	});

	it("ignores same-commit siblings when routing the #2067 merge group to trunk", async () => {
		const own = {
			id: 50,
			status: "in_progress",
			created_at: new Date(SLIP_NOW).toISOString(),
			path: ".github/workflows/hobo-ci.yml",
			head_sha: "S",
		};
		const siblings = [
			{ id: 49, path: ".github/workflows/release-hobo.yml" },
			{ id: 48, path: ".github/workflows/actions-lock.yml" },
			{ id: 47, path: ".github/workflows/release-integration.yml" },
		].map(({ id, path }) => ({
			id,
			status: "queued",
			created_at: new Date(SLIP_NOW).toISOString(),
			path,
			head_sha: "S",
		}));
		const page = {
			workflow_runs: [
				own,
				...siblings,
				{
					id: 40,
					path: PROBE_WORKFLOW_PATH,
					status: "completed",
					created_at: new Date(SLIP_NOW - 70_000).toISOString(),
					updated_at: new Date(SLIP_NOW - 50_000).toISOString(),
				},
			],
		};
		const answer = (path: string): JsonValue =>
			path.includes("/jobs")
				? {
						jobs: path.includes("/runs/40/")
							? [recentPickup("hobo-trunk")]
							: [],
					}
				: page;
		const view = await observeQueue({
			read: async (path) => answer(path),
			repository: "Hobo-Labs/HoBo",
			ownRunId: 50,
			labels: ["hobo-trunk"],
			limits,
			nowMs: SLIP_NOW,
		});
		assert.equal(view.undecidedAhead, 0);
		const { decision } = await mergeGroupRoute(answer);
		assert.deepEqual([decision.tier, decision.runner], ["fleet", "hobo-trunk"]);
	});

	it("admits a young full merge-group trunk queue without relaxing PR routing", async () => {
		const youngTrunkQueue = [
			...Array.from({ length: 5 }, () => waiting("hobo-trunk", 0)),
			recentPickup("hobo-trunk"),
		];
		const { decision } = await mergeGroupRoute(observed(youngTrunkQueue));
		assert.deepEqual([decision.tier, decision.runner], ["fleet", "hobo-trunk"]);
		const prDecision = await chooseRunner({
			observe: async () => ({
				jobs: [
					...Array.from({ length: 5 }, () => ({
						runId: 40,
						labels: ["hobo"],
						createdAtMs: NOW,
					})),
					taken("hobo", 1, 60),
				],
				undecidedAhead: 0,
				probeUnderway: false,
			}),
			now: () => NOW,
			sleep: async () => {},
			mode: "auto",
			fleetLabel: "hobo",
			localEnrolled: false,
			limits,
		});
		assert.deepEqual(
			[prDecision.tier, prDecision.runner],
			["github", "ubuntu-24.04"],
		);
	});

	it("keeps the 120-second merge-group queue wait refusal", async () => {
		const { decision } = await mergeGroupRoute(
			observed([waiting("hobo-trunk", 120), recentPickup("hobo-trunk")]),
		);
		assert.deepEqual(
			[decision.tier, decision.runner],
			["github", "ubuntu-24.04"],
		);
	});

	it("keeps the 90-second merge-group confirmation wait refusal", async () => {
		const decision = await confirmMergeGroupFabricFleet({
			fleetDecision: {
				tier: "fleet",
				runner: "hobo-trunk",
				reason: "candidate",
			},
			observe: async () => ({
				jobs: [
					{
						runId: 40,
						labels: ["hobo-trunk"],
						createdAtMs: NOW - 90_000,
					},
					taken("hobo-trunk", 1, 60),
				],
				undecidedAhead: 0,
				probeUnderway: false,
			}),
			now: () => NOW,
			sleep: async () => {},
			fleetLabel: "hobo-trunk",
			githubLabel: "ubuntu-24.04",
			limits,
			slowPickupWindowSeconds: RECENT_PICKUP_SECONDS,
		});
		assert.deepEqual(
			[decision.tier, decision.runner],
			["github", "ubuntu-24.04"],
		);
	});

	it("forgets a cold-start pickup after 15 minutes only for merge-group Fabric", async () => {
		const oldColdStart = await mergeGroupRoute(
			observed([
				recentPickup("hobo-trunk", 175, 20 * 60),
				recentPickup("hobo-trunk"),
			]),
		);
		assert.deepEqual(
			[oldColdStart.decision.tier, oldColdStart.decision.runner],
			["fleet", "hobo-trunk"],
		);
		const recentColdStart = await mergeGroupRoute(
			observed([
				recentPickup("hobo-trunk", 175, 5 * 60),
				recentPickup("hobo-trunk"),
			]),
		);
		assert.deepEqual(
			[recentColdStart.decision.tier, recentColdStart.decision.runner],
			["github", "ubuntu-24.04"],
		);
	});

	it("never diverts a fork pull-request batch to the fleet when GitHub-hosted is saturated", async () => {
		const asked: string[] = [];
		const batchFetch: typeof fetch = async (url) => {
			asked.push(String(url));
			const repo = publicRepoRead(url);
			if (repo) return repo;
			if (String(url).includes("/jobs"))
				return Response.json({ jobs: saturatedHostedQueue() });
			return Response.json({
				workflow_runs: [
					{
						id: 40,
						path: PROBE_WORKFLOW_PATH,
						status: "completed",
						created_at: new Date(SLIP_NOW - 70_000).toISOString(),
						updated_at: new Date(SLIP_NOW - 50_000).toISOString(),
					},
				],
			});
		};
		const { decision } = await printedBy(() =>
			main(
				[],
				{ ...prBatchCi, GITHUB_API_URL: "https://api.github.com" },
				{
					routingConfig: COMMITTED,
					eventPayload: forkPull,
					fetch: batchFetch,
					now: () => SLIP_NOW,
				},
			),
		);
		assert.deepEqual(
			[decision.tier, decision.runner, decision.refusedBy],
			["github", "ubuntu-24.04", "none"],
		);
		assert.match(decision.reason, /full PR batch.*no verified fleet capacity/u);
		assert.ok(
			!asked.some((path) => path.includes("/actions/runs")),
			asked.join("\n"),
		);
	});

	it("keeps PR batches with missing or malformed repository provenance on GitHub-hosted", async () => {
		for (const eventPayload of [undefined, {}, { pull_request: {} }]) {
			const asked: string[] = [];
			const { decision } = await printedBy(() =>
				main(
					[],
					{ ...prBatchCi, GITHUB_API_URL: "https://api.github.com" },
					{
						routingConfig: COMMITTED,
						eventPayload,
						fetch: async (url) => {
							asked.push(String(url));
							return (
								publicRepoRead(url) ??
								new Response("unexpected queue read", { status: 500 })
							);
						},
						now: () => SLIP_NOW,
					},
				),
			);
			assert.deepEqual(
				[decision.tier, decision.runner, decision.refusedBy],
				["github", "ubuntu-24.04", "none"],
			);
			assert.ok(
				asked.every(
					(path) => path === "https://api.github.com/repos/Hobo-Labs/HoBo",
				),
				asked.join("\n"),
			);
		}
	});

	it("falls back to GitHub-hosted when the same-repository PR batch hosted probe answers 401", async () => {
		const { decision, lines } = await printedBy(() =>
			main(
				[],
				{ ...prBatchCi, GITHUB_API_URL: "https://api.github.com" },
				{
					routingConfig: COMMITTED,
					eventPayload: SAME_REPOSITORY_PULL,
					fetch: async (url) =>
						publicRepoRead(url) ??
						new Response("unauthorized", { status: 401 }),
					now: () => SLIP_NOW,
				},
			),
		);
		assert.deepEqual(
			[decision.tier, decision.runner, decision.refusedBy],
			["github", "ubuntu-24.04", "queue"],
		);
		assert.match(decision.reason, /hosted-runner queue probe failed/u);
		assert.match(
			decision.reason,
			/public standard-runner compute was verified/u,
		);
		assert.match(
			lines.join("\n"),
			/PR batch hosted-runner queue probe failed/u,
		);
	});

	it("fails closed when PR batch hosted probe cannot verify public compute", async () => {
		await assert.rejects(
			main(
				[],
				{
					...prBatchCi,
					GITHUB_TOKEN: "",
					GITHUB_API_URL: "https://api.github.com",
					GITHUB_REPOSITORY_ID: "1274791462",
					GITHUB_REPOSITORY_OWNER_ID: "344805935",
				},
				{
					routingConfig: COMMITTED,
					eventPayload: SAME_REPOSITORY_PULL,
					fetch: async (url) =>
						publicRepoRead(url) ?? new Response("unexpected", { status: 500 }),
					now: () => SLIP_NOW,
				},
			),
			/PR batch hosted-runner public compute evidence is unavailable/u,
		);
	});

	it("fails closed when merge-group probe is unreadable and public compute cannot be verified", async () => {
		await assert.rejects(
			main(
				[],
				{
					...mergeGroupCi,
					GITHUB_TOKEN: "",
					GITHUB_API_URL: "https://api.github.com",
					GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
					GITHUB_REPOSITORY_ID: "1274791462",
					GITHUB_REPOSITORY_OWNER_ID: "344805935",
				},
				{
					routingConfig: COMMITTED,
					fetch: async (url) =>
						publicRepoRead(url) ?? new Response("unexpected", { status: 500 }),
				},
			),
			/merge-group hosted fallback requires verified public compute evidence/u,
		);
	});

	it("fails closed when merge-group probe has no repository and public compute cannot be verified", async () => {
		await assert.rejects(
			main(
				[],
				{
					...mergeGroupCi,
					GITHUB_API_URL: "https://api.github.com",
					GITHUB_REPOSITORY: "",
					GITHUB_REPOSITORY_ID: "1274791462",
					GITHUB_REPOSITORY_OWNER_ID: "344805935",
				},
				{
					routingConfig: COMMITTED,
					fetch: async (url) =>
						publicRepoRead(url) ?? new Response("unexpected", { status: 500 }),
				},
			),
			/merge-group hosted fallback requires verified public compute evidence/u,
		);
	});

	it("rejects fork-origin merge-group pull requests before trusted routing", async () => {
		let claimed = false;
		await assert.rejects(
			main([], mergeGroupCi, {
				routingConfig: COMMITTED,
				eventPayload: forkPull,
				fetch: async () => {
					throw new Error("unexpected read");
				},
				verifyPrBatchCapacity: async () => {
					claimed = true;
					return true;
				},
			}),
			/merge-group fork or unknown pull-request provenance cannot use trusted routing/u,
		);
		assert.equal(claimed, false);
	});

	it("requires a verified claim for pinned merge-group release fleet routing", async () => {
		await withGithub(observed([pickup("hobo-trunk")]), async (apiUrl) => {
			await assert.rejects(
				route(apiUrl, undefined, mergeGroupRelease, ["--route", "fleet"]),
				/merge-group fleet routing requires a verified capacity and Broker claim/u,
			);
			const { decision } = await route(
				apiUrl,
				undefined,
				mergeGroupRelease,
				["--route", "fleet"],
				COMMITTED,
				async (scope) => {
					assert.equal(scope.runner, "hobo-trunk");
					assert.equal(
						scope.workflowPath,
						".github/workflows/release-hobo.yml",
					);
					return true;
				},
			);
			assert.deepEqual(
				[decision.tier, decision.runner],
				["fleet", "hobo-trunk"],
			);
			assert.deepEqual(decision.slip, {
				kind: "unasked",
				why: "merge-group",
			});
		});
	});

	it("routes merge-group CI to trunk even while hosted runners have idle capacity", async () => {
		await withGithub(
			observed([pickup("hobo"), pickup("hobo-trunk")]),
			async (apiUrl) => {
				const { decision } = await route(
					apiUrl,
					undefined,
					mergeGroupCi,
					[],
					COMMITTED,
					async () => true,
				);
				assert.deepEqual(
					[decision.tier, decision.runner, decision.refusedBy],
					["fleet", "hobo-trunk", "none"],
				);
				assert.match(decision.reason, /verified capacity and Broker claim/u);
				assert.deepEqual(decision.slip, {
					kind: "unasked",
					why: "merge-group",
				});
			},
		);
	});

	it("routes merge-group CI to hobo-trunk when GitHub-hosted is saturated and trunk is idle", async () => {
		await withGithub(
			observed([...saturatedHostedQueue(), pickup("hobo-trunk")]),
			async (apiUrl) => {
				const { decision } = await route(
					apiUrl,
					undefined,
					mergeGroupCi,
					[],
					COMMITTED,
					async () => true,
				);
				assert.deepEqual(
					[decision.tier, decision.runner, decision.refusedBy],
					["fleet", "hobo-trunk", "none"],
				);
				assert.deepEqual(decision.slip, {
					kind: "unasked",
					why: "merge-group",
				});
			},
		);
	});

	it("keeps a healthy merge-group trunk batch hosted without a claim", async () => {
		await withGithub(
			observed([...saturatedHostedQueue(), pickup("hobo-trunk")]),
			async (apiUrl) => {
				const { decision } = await route(apiUrl, undefined, mergeGroupCi);
				assert.deepEqual(
					[decision.tier, decision.runner, decision.refusedBy],
					["github", "ubuntu-24.04", "queue"],
				);
				assert.match(decision.reason, /no verified capacity and Broker claim/u);
				assert.equal(decision.mergeGroupHostedProbe?.trunkIdle, true);
			},
		);
	});

	it("keeps an automatic merge-group release on verified public compute", async () => {
		const { decision } = await printedBy(() =>
			main(
				[],
				{
					...mergeGroupRelease,
					GITHUB_API_URL: "https://api.github.com",
					GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
					GITHUB_REPOSITORY_ID: "1274791462",
					GITHUB_REPOSITORY_OWNER_ID: "344805935",
				},
				{
					routingConfig: COMMITTED,
					fetch: async (url) =>
						publicRepoRead(url) ??
						new Response("unexpected queue read", { status: 500 }),
					now: () => SLIP_NOW,
				},
			),
		);
		assert.deepEqual(
			[decision.tier, decision.runner, decision.refusedBy],
			["github", "ubuntu-24.04", "none"],
		);
		assert.match(
			decision.reason,
			/public standard-runner compute was verified/u,
		);
		assert.deepEqual(decision.slip, { kind: "unasked", why: "batch" });
	});

	it("falls back to GitHub-hosted instead of choosing trunk without recent pickup", async () => {
		const { decision, lines } = await printedBy(() =>
			main(
				[],
				{
					...mergeGroupCi,
					GITHUB_API_URL: "https://api.github.com",
					GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
					GITHUB_REPOSITORY_ID: "1274791462",
					GITHUB_REPOSITORY_OWNER_ID: "344805935",
				},
				{
					routingConfig: COMMITTED,
					fetch: async (url) =>
						publicRepoRead(url) ??
						new Response(
							JSON.stringify(
								observed(saturatedHostedQueue())(
									String(url).replace("https://api.github.com", ""),
								),
							),
							{ status: 200, headers: { "content-type": "application/json" } },
						),
					now: () => SLIP_NOW,
				},
			),
		);
		assert.deepEqual(
			[decision.tier, decision.runner, decision.refusedBy],
			["github", "ubuntu-24.04", "queue"],
		);
		assert.match(decision.reason, /no healthy hobo-trunk capacity/u);
		assert.match(lines.join("\n"), /hobo-ci-route-fallback/);
	});

	it("keeps merge-group Fabric on trunk while its waiters are young", async () => {
		const { decision } = await mergeGroupRoute(
			observed([
				...saturatedHostedQueue(),
				pickup("hobo-trunk"),
				waiting("hobo-trunk", 12),
			]),
		);
		assert.deepEqual(
			[decision.tier, decision.runner, decision.refusedBy],
			["fleet", "hobo-trunk", "none"],
		);
	});

	it("falls back to GitHub-hosted while trunk has waiters and runs are choosing", async () => {
		const fetchImpl = (path: string) => {
			if (path.includes("/jobs"))
				return {
					jobs: [
						...saturatedHostedQueue(),
						pickup("hobo-trunk"),
						waiting("hobo-trunk", 2),
					],
				};
			return {
				workflow_runs: [
					{
						id: 40,
						path: PROBE_WORKFLOW_PATH,
						status: "completed",
						created_at: new Date(SLIP_NOW - 70_000).toISOString(),
						updated_at: new Date(SLIP_NOW - 50_000).toISOString(),
					},
					{
						id: 50,
						path: ".github/workflows/hobo-ci.yml",
						status: "in_progress",
						created_at: new Date(SLIP_NOW - 10_000).toISOString(),
						updated_at: new Date(SLIP_NOW - 10_000).toISOString(),
					},
				],
			};
		};
		const { decision } = await printedBy(() =>
			main(
				[],
				{
					...mergeGroupCi,
					GITHUB_API_URL: "https://api.github.com",
					GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
					GITHUB_REPOSITORY_ID: "1274791462",
					GITHUB_REPOSITORY_OWNER_ID: "344805935",
				},
				{
					routingConfig: COMMITTED,
					fetch: async (url) =>
						publicRepoRead(url) ??
						new Response(
							JSON.stringify(
								fetchImpl(String(url).replace("https://api.github.com", "")),
							),
							{ status: 200, headers: { "content-type": "application/json" } },
						),
					now: () => SLIP_NOW,
				},
			),
		);
		assert.deepEqual(
			[decision.tier, decision.runner, decision.refusedBy],
			["github", "ubuntu-24.04", "queue"],
		);
	});

	it("ignores a hostile trunk slip on merge-group Fabric", async () => {
		const hostile = structuredClone(JSON.parse(OPEN_SLIP));
		hostile.classes.trunk = {
			runner: "hobo",
			tier: "fleet",
			reason: "fleet-open",
		};
		await withGithub(
			observed([...saturatedHostedQueue(), pickup("hobo-trunk")]),
			async (apiUrl) => {
				const { decision } = await route(
					apiUrl,
					JSON.stringify(hostile),
					mergeGroupCi,
					[],
					COMMITTED,
					async () => true,
				);
				assert.notEqual(decision.runner, "hobo");
				assert.equal(decision.tier, "fleet");
				assert.equal(decision.runner, "hobo-trunk");
				assert.deepEqual(decision.slip, {
					kind: "unasked",
					why: "merge-group",
				});
			},
		);
	});

	it("never routes merge-group Fabric to the general hobo label while the trunk has idle capacity", async () => {
		await withGithub(
			observed([...saturatedHostedQueue(), pickup("hobo-trunk")]),
			async (apiUrl) => {
				const { decision } = await route(
					apiUrl,
					undefined,
					mergeGroupCi,
					[],
					COMMITTED,
					async () => true,
				);
				assert.deepEqual(
					[decision.tier, decision.runner, decision.refusedBy],
					["fleet", "hobo-trunk", "none"],
				);
				assert.doesNotMatch(decision.runner, /^hobo$/u);
			},
		);
	});

	it("routes merge-group CI to GitHub-hosted when hobo-trunk has no recent pickup", async () => {
		const { decision } = await mergeGroupRoute(observed([]));
		assert.deepEqual(
			[decision.tier, decision.runner, decision.refusedBy],
			["github", "ubuntu-24.04", "queue"],
		);
	});

	it("refuses merge-group Fabric auto routing without committed policy", async () => {
		await assert.rejects(
			() =>
				main([], mergeGroupCi, {
					...NO_SLIP_CALL,
					routingConfig: "{}",
				}),
			/merge-group Fabric routing requires a valid committed policy/u,
		);
	});

	it("refuses general hobo on merge-group when include-own-run is true", async () => {
		const generalFleetSlip = JSON.parse(OPEN_SLIP);
		generalFleetSlip.classes.trunk = {
			runner: "hobo",
			tier: "fleet",
			reason: "fleet-open",
		};
		await withGithub(observed([pickup("hobo")]), async (apiUrl) => {
			const { decision } = await route(
				apiUrl,
				JSON.stringify(generalFleetSlip),
				mergeGroupCi,
				["--include-own-run", "true"],
			);
			assert.deepEqual(
				[decision.tier, decision.runner, decision.refusedBy],
				["github", "ubuntu-24.04", "queue"],
			);
			assert.match(
				decision.reason,
				/merge-group Fabric refused the general fleet label hobo/u,
			);
		});
	});

	it("keeps an open fleet slip only when its exact label is taking jobs", async () => {
		await withGithub(observed([pickup("hobo")]), async (apiUrl) => {
			const { decision } = await route(apiUrl, OPEN_SLIP);
			assert.deepEqual(
				[decision.tier, decision.runner, decision.refusedBy],
				["fleet", "hobo", "none"],
			);
			assert.match(decision.reason, /fleet-open/);
		});
	});

	it("keeps an open fleet for the earlier undecided run during a burst", async () => {
		const pages = (path: string): JsonValue => {
			if (path.includes("/runs/40/jobs"))
				return { jobs: [pickup("hobo"), pickup("hobo-trunk")] };
			if (path.includes("/runs/50/jobs"))
				return { jobs: [{ status: "in_progress" }] };
			return {
				workflow_runs: [
					{
						id: 40,
						path: PROBE_WORKFLOW_PATH,
						status: "completed",
						created_at: new Date(SLIP_NOW - 70_000).toISOString(),
						updated_at: new Date(SLIP_NOW - 50_000).toISOString(),
					},
					{
						id: 50,
						path: ".github/workflows/hobo-ci.yml",
						status: "in_progress",
						created_at: new Date(SLIP_NOW - 10_000).toISOString(),
						updated_at: new Date(SLIP_NOW - 10_000).toISOString(),
					},
				],
			};
		};
		await withGithub(pages, async (apiUrl) => {
			const { decision } = await route(apiUrl, OPEN_SLIP);
			assert.deepEqual(
				[decision.tier, decision.runner, decision.refusedBy],
				["github", "ubuntu-24.04", "queue"],
			);
			assert.match(decision.reason, /1 run\(s\) started/);
			const busy = await route(apiUrl, OPEN_SLIP, {
				GITHUB_EVENT_NAME: "push",
			});
			assert.deepEqual(
				[busy.decision.tier, busy.decision.runner, busy.decision.refusedBy],
				["fleet", "hobo-trunk", "none"],
			);
		});
	});

	it("routes a stalled fleet-open slip to GitHub-hosted and records the queue refusal", async () => {
		await withGithub(
			observed(Array.from({ length: 9 }, () => waiting("hobo", 300))),
			async (apiUrl) => {
				const { decision, lines } = await route(apiUrl, OPEN_SLIP);
				assert.deepEqual(
					[decision.tier, decision.runner, decision.refusedBy],
					["github", "ubuntu-24.04", "queue"],
				);
				assert.match(decision.reason, /fleet-open/);
				assert.deepEqual(noticesIn(lines), [
					notice({
						tier: "github",
						runner: "ubuntu-24.04",
						slip: "used",
						why: "fleet-open",
						refusedBy: "queue",
					}),
				]);
			},
		);
	});

	it("uses an enrolled local runner with a recent pickup when the fleet is stalled", async () => {
		await withGithub(
			observed([waiting("hobo", 300), pickup("hobo-local-host")]),
			async (apiUrl) => {
				const config = withRouting((routing) => {
					routing.localRunner = true;
				});
				const { decision } = await route(apiUrl, OPEN_SLIP, {}, [], config);
				assert.deepEqual(
					[decision.tier, decision.runner, decision.refusedBy],
					["local", "hobo-local-host", "queue"],
				);
			},
		);
	});

	it("keeps a busy fleet with timely pickups even when several jobs are queued (R4)", async () => {
		await withGithub(
			observed([
				pickup("hobo-trunk"),
				...Array.from({ length: 5 }, () => waiting("hobo-trunk", 10)),
			]),
			async (apiUrl) => {
				const { decision } = await route(apiUrl, OPEN_SLIP, {
					GITHUB_EVENT_NAME: "push",
				});
				assert.deepEqual(
					[decision.tier, decision.runner, decision.refusedBy],
					["fleet", "hobo-trunk", "none"],
				);
				assert.match(decision.reason, /fleet-busy/);
			},
		);
	});

	it("rejects a busy fleet when a queued job has waited past the limit", async () => {
		await withGithub(
			observed([pickup("hobo-trunk"), waiting("hobo-trunk", 300)]),
			async (apiUrl) => {
				const { decision } = await route(apiUrl, OPEN_SLIP, {
					GITHUB_EVENT_NAME: "push",
				});
				assert.deepEqual(
					[decision.tier, decision.runner, decision.refusedBy],
					["github", "ubuntu-24.04", "queue"],
				);
			},
		);
	});

	it("continues reading a busy fleet's queue after finding a young backlog", async () => {
		const pages = (path: string): JsonValue => {
			if (path.includes("/runs/40/jobs"))
				return {
					jobs: [
						pickup("hobo-trunk"),
						...Array.from({ length: 5 }, () => waiting("hobo-trunk", 10)),
					],
				};
			if (path.includes("/runs/42/jobs"))
				return { jobs: [waiting("hobo-trunk", 300)] };
			return {
				workflow_runs: [
					{
						id: 40,
						path: PROBE_WORKFLOW_PATH,
						status: "completed",
						created_at: new Date(SLIP_NOW - 70_000).toISOString(),
						updated_at: new Date(SLIP_NOW - 50_000).toISOString(),
					},
					{
						id: 42,
						path: ".github/workflows/hobo-ci.yml",
						status: "in_progress",
						created_at: new Date(SLIP_NOW - 300_000).toISOString(),
						updated_at: new Date(SLIP_NOW - 300_000).toISOString(),
					},
				],
			};
		};
		await withGithub(pages, async (apiUrl) => {
			const { decision } = await route(apiUrl, OPEN_SLIP, {
				GITHUB_EVENT_NAME: "push",
			});
			assert.deepEqual(
				[decision.tier, decision.runner, decision.refusedBy],
				["github", "ubuntu-24.04", "queue"],
			);
		});
	});

	it("rejects an open fleet when too many new jobs are already waiting", async () => {
		await withGithub(
			observed([
				pickup("hobo"),
				...Array.from({ length: 5 }, () => waiting("hobo", 10)),
			]),
			async (apiUrl) => {
				const { decision } = await route(apiUrl, OPEN_SLIP);
				assert.deepEqual(
					[decision.tier, decision.runner, decision.refusedBy],
					["github", "ubuntu-24.04", "queue"],
				);
			},
		);
	});

	it("checks this run's stalled job when it asks again before its shards", async () => {
		const pages = (path: string): JsonValue => {
			if (path.includes("/runs/51/jobs"))
				return { jobs: [waiting("hobo", 300)] };
			return observed([pickup("hobo")])(path);
		};
		await withGithub(pages, async (apiUrl) => {
			const initial = await route(apiUrl, OPEN_SLIP);
			assert.equal(initial.decision.runner, "hobo");
			const reask = await route(apiUrl, OPEN_SLIP, {}, [
				"--include-own-run",
				"true",
			]);
			assert.deepEqual(
				[reask.decision.tier, reask.decision.runner, reask.decision.refusedBy],
				["github", "ubuntu-24.04", "queue"],
			);
		});
	});

	it("does not mistake another label's pickup for the slip's fleet", async () => {
		await withGithub(observed([pickup("hobo")]), async (apiUrl) => {
			const { decision } = await route(apiUrl, OPEN_SLIP, {
				GITHUB_EVENT_NAME: "push",
			});
			assert.deepEqual(
				[decision.tier, decision.runner, decision.refusedBy],
				["github", "ubuntu-24.04", "queue"],
			);
		});
	});

	it("uses GitHub-hosted when a fleet slip cannot be verified against the queue", async () => {
		const { decision } = await route("http://127.0.0.1:9", OPEN_SLIP);
		assert.deepEqual(
			[decision.tier, decision.runner, decision.refusedBy],
			["github", "ubuntu-24.04", "queue"],
		);
		assert.match(decision.reason, /queue could not be read/);
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

	it("annotates why no slip was read for a pinned run", async () => {
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

describe("hobo pool saturation overflow", () => {
	it("counts the online runners serving the pool label, busy or not", () => {
		const runner = (
			busy: boolean,
			labels: readonly string[],
			status = "online",
		) => ({
			name: "hobo-runner",
			status,
			busy,
			labels: labels.map((name) => ({ name })),
		});
		assert.deepEqual(
			fleetPoolRunners(
				{
					runners: [
						runner(true, ["self-hosted", "linux", "hobo"]),
						runner(false, ["hobo"]),
						runner(true, ["hobo"], "offline"),
						runner(false, ["hobo-trunk"]),
						runner(false, ["HoBo"]),
					],
				},
				"hobo",
			),
			{ online: 3, busy: 1 },
		);
		assert.deepEqual(fleetPoolRunners({ runners: [] }, "hobo"), {
			online: 0,
			busy: 0,
		});
	});

	it("says nothing when the runner list is not the shape GitHub answers", () => {
		assert.equal(
			fleetPoolRunners(
				{ message: "Resource not accessible by integration" },
				"hobo",
			),
			undefined,
		);
		assert.equal(fleetPoolRunners({ workflow_runs: [] }, "hobo"), undefined);
		assert.equal(fleetPoolRunners({}, "hobo"), undefined);
		assert.equal(
			fleetPoolRunners({ runners: [{ status: "online" }] }, "hobo"),
			undefined,
		);
	});

	it("reads the host CPU percent only as a bare integer", () => {
		assert.equal(parseNodeCpuPercent("93"), 93);
		assert.equal(parseNodeCpuPercent(" 91 "), 91);
		assert.equal(parseNodeCpuPercent("0"), 0);
		for (const bad of ["93.5", "95%", "high", "  ", ""])
			assert.equal(parseNodeCpuPercent(bad), undefined, JSON.stringify(bad));
		assert.equal(parseNodeCpuPercent(undefined), undefined);
	});

	it("saturates when every online pool runner is busy, or the host CPU is past the limit", () => {
		assert.equal(HOBO_POOL_CPU_SATURATED_ABOVE_PERCENT, 90);
		assert.deepEqual(
			hoboPoolSaturation({
				runners: { online: 5, busy: 5 },
				cpuPercent: undefined,
				label: "hobo",
			}),
			{
				saturated: true,
				summary:
					"the hobo pool has no idle capacity (5 of 5 online hobo runners busy)",
			},
		);
		assert.deepEqual(
			hoboPoolSaturation({
				runners: undefined,
				cpuPercent: 93,
				label: "hobo",
			}),
			{
				saturated: true,
				summary: "the hobo pool has no idle capacity (host node CPU 93%)",
			},
		);
		assert.equal(
			hoboPoolSaturation({
				runners: { online: 3, busy: 2 },
				cpuPercent: 90,
				label: "hobo",
			}).saturated,
			false,
		);
	});

	it("never saturates on unreadable evidence alone (R3)", () => {
		const unknown = hoboPoolSaturation({
			runners: undefined,
			cpuPercent: undefined,
			label: "hobo",
		});
		assert.equal(unknown.saturated, false);
		assert.match(
			unknown.summary,
			/hobo pool saturation unknown \(repository runner list unreadable; host node CPU unknown\)/u,
		);
		assert.equal(
			hoboPoolSaturation({
				runners: { online: 0, busy: 0 },
				cpuPercent: undefined,
				label: "hobo",
			}).saturated,
			false,
		);
	});

	const poolPages = (
		runnersPage: JsonValue,
		variableValue: string | undefined,
	): ((path: string) => JsonValue) => {
		const pickup = (label: string) => ({
			run_id: 40,
			status: "completed",
			labels: [label],
			runner_name: "runner-1",
			created_at: new Date(SLIP_NOW - 65_000).toISOString(),
			started_at: new Date(SLIP_NOW - 60_000).toISOString(),
		});
		return (path) => {
			if (path.includes("/actions/runners")) return runnersPage;
			if (path.includes("/actions/variables/"))
				return variableValue === undefined
					? { message: "Not Found" }
					: {
							name: HOBO_CI_NODE_CPU_PERCENT_VARIABLE,
							value: variableValue,
						};
			if (path.includes("/jobs"))
				return { jobs: [pickup("hobo"), pickup("hobo-trunk")] };
			return {
				workflow_runs: [
					{
						id: 40,
						path: PROBE_WORKFLOW_PATH,
						status: "completed",
						created_at: new Date(SLIP_NOW - 70_000).toISOString(),
						updated_at: new Date(SLIP_NOW - 50_000).toISOString(),
					},
				],
			};
		};
	};
	const busyPool = (
		online: number,
		busy = online,
		overflowStatus: "online" | "offline" | null = "online",
		overflowBusy = false,
	): JsonValue => ({
		runners: [
			...Array.from({ length: online }, (_, index) => ({
				name: `hobo-runner-${index + 1}`,
				status: "online",
				busy: index < busy,
				labels: [{ name: "hobo" }],
			})),
			...(overflowStatus === null
				? []
				: [
						{
							name: "agent37-runner-1",
							status: overflowStatus,
							busy: overflowBusy,
							labels: [{ name: AGENT37_OVERFLOW_RUNNER_LABEL }],
						},
					]),
		],
	});
	const prBatchEnv = {
		GITHUB_EVENT_NAME: "pull_request",
		GITHUB_WORKFLOW_REF:
			"Hobo-Labs/HoBo/.github/workflows/hobo-ci.yml@refs/pull/1/merge",
		GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
		GITHUB_REPOSITORY_ID: "1274791462",
		GITHUB_REPOSITORY_OWNER_ID: "344805935",
		GITHUB_RUN_ID: "51",
		GITHUB_TOKEN: "token",
	};
	const forkPayload: JsonValue = {
		pull_request: {
			base: { repo: { full_name: "Hobo-Labs/HoBo" } },
			head: { repo: { full_name: "someone/HoBo" } },
		},
	};
	const publicRepo = (url: RequestInfo | URL): Response | undefined =>
		String(url) === "https://api.github.com/repos/Hobo-Labs/HoBo"
			? Response.json({
					id: 1274791462,
					owner: { id: 344805935 },
					private: false,
					visibility: "public",
					disabled: false,
					archived: false,
				})
			: undefined;
	const hostedSaturated = (): JsonValue[] =>
		Array.from({ length: 5 }, (_, index) => ({
			run_id: 40,
			status: "queued",
			labels: ["ubuntu-24.04"],
			created_at: new Date(SLIP_NOW - (10 + index) * 1000).toISOString(),
		}));
	const overflowRoute = (
		answer: (path: string) => JsonValue,
		env: Record<string, string> = {},
		eventPayload: JsonValue | undefined = SAME_REPOSITORY_PULL,
	) =>
		withGithub(answer, (apiUrl) =>
			printedBy(() =>
				main(
					[],
					{
						GITHUB_EVENT_NAME: "pull_request",
						GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
						GITHUB_RUN_ID: "51",
						GITHUB_API_URL: apiUrl,
						GITHUB_TOKEN: "token",
						...env,
					},
					{
						routingConfig: COMMITTED,
						eventPayload,
						fetch: async (url, init) =>
							String(url).includes("/git/")
								? Response.json({ message: "Not Found" }, { status: 404 })
								: fetch(url, init),
						now: () => SLIP_NOW,
					},
				),
			),
		);

	it("overflows to hobo-agent37 with a titled warning when every online pool runner is busy", async () => {
		const { decision, lines } = await overflowRoute(
			poolPages(busyPool(5), undefined),
		);
		assert.deepEqual(
			[decision.tier, decision.runner, decision.refusedBy],
			["fleet", AGENT37_OVERFLOW_RUNNER_LABEL, "queue"],
		);
		assert.match(
			decision.reason,
			/the hobo pool has no idle capacity \(5 of 5 online hobo runners busy\)/u,
		);
		assert.match(decision.reason, /the run overflows to hobo-agent37/u);
		assert.ok(
			warningsIn(lines).some(
				(line) =>
					line.startsWith("::warning title=hobo-ci-route-fallback::") &&
					line.includes(
						"the hobo pool has no idle capacity (5 of 5 online hobo runners busy)",
					) &&
					line.includes("the run overflows to hobo-agent37"),
			),
			lines.join("\n"),
		);
		assert.ok(
			noticesIn(lines).some((line) =>
				line.includes(`"runner":"${AGENT37_OVERFLOW_RUNNER_LABEL}"`),
			),
			lines.join("\n"),
		);
	});

	it("stays on the prior fleet decision when every online hobo-agent37 runner is busy", async () => {
		const { decision, lines } = await overflowRoute(
			poolPages(busyPool(5, 5, "online", true), undefined),
		);
		assert.deepEqual(
			[decision.tier, decision.runner, decision.refusedBy],
			["fleet", "hobo", "none"],
		);
		assert.match(decision.reason, /no idle hobo-agent37 runner was verified/u);
		assert.ok(
			warningsIn(lines).some((line) =>
				line.includes("no idle hobo-agent37 runner was verified"),
			),
		);
	});

	it("stays on the prior fleet decision without a verified idle hobo-agent37 runner", async () => {
		const scenarios = [
			{ runnersPage: busyPool(5, 5, null), cpuPercent: undefined },
			{ runnersPage: busyPool(5, 5, "offline"), cpuPercent: undefined },
			{
				runnersPage: { message: "Resource not accessible by integration" },
				cpuPercent: "93",
			},
		];
		for (const scenario of scenarios) {
			const { decision, lines } = await overflowRoute(
				poolPages(scenario.runnersPage, scenario.cpuPercent),
			);
			assert.deepEqual([decision.tier, decision.runner], ["fleet", "hobo"]);
			assert.match(
				decision.reason,
				/no idle hobo-agent37 runner was verified on the fetched runner page/u,
			);
			assert.match(decision.reason, /the run stays on hobo/u);
			assert.ok(
				warningsIn(lines).some(
					(line) =>
						line.includes(
							"no idle hobo-agent37 runner was verified on the fetched runner page",
						) && line.includes("the run stays on hobo"),
				),
				lines.join("\n"),
			);
		}
	});

	it("keeps the fleet when neither leg can be read: unreadable is not saturation (R3)", async () => {
		const { decision, lines } = await overflowRoute(
			poolPages(
				{ message: "Resource not accessible by integration" },
				undefined,
			),
		);
		assert.deepEqual([decision.tier, decision.runner], ["fleet", "hobo"]);
		assert.match(
			decision.reason,
			/hobo pool saturation unknown \(repository runner list unreadable; host node CPU unknown\)/u,
		);
		assert.ok(
			!warningsIn(lines).some((line) =>
				line.includes(AGENT37_OVERFLOW_RUNNER_LABEL),
			),
			lines.join("\n"),
		);
	});

	it("overflows on host CPU above the limit alone, and names the percent", async () => {
		const { decision, lines } = await overflowRoute(
			poolPages(busyPool(0), "93"),
		);
		assert.deepEqual(
			[decision.tier, decision.runner],
			["fleet", AGENT37_OVERFLOW_RUNNER_LABEL],
		);
		assert.match(decision.reason, /host node CPU 93%/u);
		assert.ok(
			warningsIn(lines).some(
				(line) =>
					line.startsWith("::warning title=hobo-ci-route-fallback::") &&
					line.includes("host node CPU 93%") &&
					line.includes("the run overflows to hobo-agent37"),
			),
			lines.join("\n"),
		);
	});

	it("does not overflow on host CPU at the limit or a value that is not an integer", async () => {
		for (const value of ["90", "93.5", "busy"]) {
			const { decision, lines } = await overflowRoute(
				poolPages({ runners: [] }, value),
			);
			assert.deepEqual(
				[decision.tier, decision.runner],
				["fleet", "hobo"],
				value,
			);
			assert.ok(
				!warningsIn(lines).some((line) =>
					line.includes(AGENT37_OVERFLOW_RUNNER_LABEL),
				),
				`${value}: ${lines.join("\n")}`,
			);
		}
	});

	it("never sends a fork pull request to the pool or its overflow, however saturated both look", async () => {
		const forkBatchFetch: typeof fetch = async (url) => {
			const repo = publicRepo(url);
			if (repo) return repo;
			const path = String(url);
			if (path.includes("/actions/runners")) return Response.json(busyPool(5));
			if (path.includes("/actions/variables/"))
				return Response.json({ value: "95" });
			if (path.includes("/jobs"))
				return Response.json({ jobs: hostedSaturated() });
			return Response.json({
				workflow_runs: [
					{
						id: 40,
						path: PROBE_WORKFLOW_PATH,
						status: "completed",
						created_at: new Date(SLIP_NOW - 70_000).toISOString(),
						updated_at: new Date(SLIP_NOW - 50_000).toISOString(),
					},
				],
			});
		};
		const { decision, lines } = await printedBy(() =>
			main(
				[],
				{ ...prBatchEnv, GITHUB_API_URL: "https://api.github.com" },
				{
					routingConfig: COMMITTED,
					eventPayload: forkPayload,
					fetch: forkBatchFetch,
					now: () => SLIP_NOW,
				},
			),
		);
		assert.deepEqual(
			[decision.tier, decision.runner, decision.refusedBy],
			["github", "ubuntu-24.04", "none"],
		);
		assert.ok(
			!lines.some((line) => line.includes(AGENT37_OVERFLOW_RUNNER_LABEL)),
			lines.join("\n"),
		);
	});

	it("diverts an unclaimed saturated same-repository PR batch to agent37 overflow when the hobo pool is saturated and overflow is idle", async () => {
		const batchFetch: typeof fetch = async (url) => {
			const repo = publicRepo(url);
			if (repo) return repo;
			const path = String(url);
			if (path.includes("/actions/runners")) return Response.json(busyPool(5));
			if (path.includes("/actions/variables/"))
				return Response.json({ message: "Not Found" });
			if (path.includes("/jobs"))
				return Response.json({ jobs: hostedSaturated() });
			return Response.json({
				workflow_runs: [
					{
						id: 40,
						path: PROBE_WORKFLOW_PATH,
						status: "completed",
						created_at: new Date(SLIP_NOW - 70_000).toISOString(),
						updated_at: new Date(SLIP_NOW - 50_000).toISOString(),
					},
				],
			});
		};
		const { decision, lines } = await printedBy(() =>
			main(
				[],
				{ ...prBatchEnv, GITHUB_API_URL: "https://api.github.com" },
				{
					routingConfig: COMMITTED,
					eventPayload: SAME_REPOSITORY_PULL,
					fetch: batchFetch,
					now: () => SLIP_NOW,
				},
			),
		);
		assert.deepEqual(
			[decision.tier, decision.runner],
			["fleet", AGENT37_OVERFLOW_RUNNER_LABEL],
		);
		assert.match(
			decision.reason,
			/GitHub-hosted runners have no idle capacity/u,
		);
		assert.match(
			decision.reason,
			/the hobo pool has no idle capacity \(5 of 5 online hobo runners busy\)/u,
		);
		assert.ok(
			warningsIn(lines).some(
				(line) =>
					line.startsWith("::warning title=hobo-ci-route-fallback::") &&
					line.includes("overflows to hobo-agent37"),
			),
			lines.join("\n"),
		);
	});

	it("keeps an unclaimed saturated PR batch hosted when the fleet ladder is unavailable despite idle hobo runners", async () => {
		let runnerPageReads = 0;
		const batchFetch: typeof fetch = async (url) => {
			const repo = publicRepo(url);
			if (repo) return repo;
			const path = String(url);
			if (path.includes("/actions/runners")) {
				runnerPageReads += 1;
				return Response.json(busyPool(5, 4, null));
			}
			if (path.includes("/actions/variables/"))
				return Response.json({ value: "95" });
			if (path.includes("/jobs"))
				return Response.json({ jobs: hostedSaturated() });
			return Response.json({
				workflow_runs: [
					{
						id: 40,
						path: PROBE_WORKFLOW_PATH,
						status: "completed",
						created_at: new Date(SLIP_NOW - 70_000).toISOString(),
						updated_at: new Date(SLIP_NOW - 50_000).toISOString(),
					},
				],
			});
		};
		const { decision, lines } = await printedBy(() =>
			main(
				[],
				{ ...prBatchEnv, GITHUB_API_URL: "https://api.github.com" },
				{
					routingConfig: COMMITTED,
					eventPayload: SAME_REPOSITORY_PULL,
					fetch: batchFetch,
					now: () => SLIP_NOW,
				},
			),
		);
		assert.deepEqual(
			[decision.tier, decision.runner, decision.refusedBy],
			["github", "ubuntu-24.04", "queue"],
		);
		assert.match(decision.reason, /no idle capacity/u);
		assert.match(decision.reason, /batch stays on ubuntu-24\.04/u);
		assert.ok(
			warningsIn(lines).some((line) =>
				line.includes("same-repository PR batch stays on ubuntu-24.04"),
			),
			lines.join("\n"),
		);
		assert.equal(runnerPageReads, 1);
	});

	it("keeps a saturated same-repository PR batch on GitHub-hosted without an idle target fleet runner", async () => {
		const scenarios: readonly {
			runnersPage: JsonValue;
			cpuPercent: string | undefined;
		}[] = [
			{
				runnersPage: { message: "Resource not accessible by integration" },
				cpuPercent: "93",
			},
			{ runnersPage: { runners: [] }, cpuPercent: undefined },
			{
				runnersPage: {
					runners: [
						{
							name: "hobo-busy",
							status: "online",
							busy: true,
							labels: [{ name: "hobo" }],
						},
						{
							name: "agent37-offline",
							status: "offline",
							busy: false,
							labels: [{ name: AGENT37_OVERFLOW_RUNNER_LABEL }],
						},
					],
				},
				cpuPercent: "93",
			},
		];
		for (const scenario of scenarios) {
			const batchFetch: typeof fetch = async (url) => {
				const repo = publicRepo(url);
				if (repo) return repo;
				const path = String(url);
				if (path.includes("/actions/runners"))
					return Response.json(scenario.runnersPage);
				if (path.includes("/actions/variables/"))
					return Response.json(
						scenario.cpuPercent === undefined
							? { message: "Not Found" }
							: { value: scenario.cpuPercent },
					);
				if (path.includes("/jobs"))
					return Response.json({ jobs: hostedSaturated() });
				return Response.json({
					workflow_runs: [
						{
							id: 40,
							path: PROBE_WORKFLOW_PATH,
							status: "completed",
							created_at: new Date(SLIP_NOW - 70_000).toISOString(),
							updated_at: new Date(SLIP_NOW - 50_000).toISOString(),
						},
					],
				});
			};
			const { decision, lines } = await printedBy(() =>
				main(
					[],
					{ ...prBatchEnv, GITHUB_API_URL: "https://api.github.com" },
					{
						routingConfig: COMMITTED,
						eventPayload: SAME_REPOSITORY_PULL,
						fetch: batchFetch,
						now: () => SLIP_NOW,
					},
				),
			);
			assert.deepEqual(
				[decision.tier, decision.runner, decision.refusedBy],
				["github", "ubuntu-24.04", "queue"],
			);
			assert.match(decision.reason, /no idle capacity/u);
			assert.match(decision.reason, /batch stays on ubuntu-24\.04/u);
			assert.ok(
				warningsIn(lines).some((line) =>
					line.includes("same-repository PR batch stays on ubuntu-24.04"),
				),
				lines.join("\n"),
			);
			assert.ok(
				noticesIn(lines).some((line) =>
					line.includes('"runner":"ubuntu-24.04"'),
				),
				lines.join("\n"),
			);
		}
	});

	it("leaves trunk runs on the trunk label: the pool rule is the general fleet label's", async () => {
		const { decision, lines } = await overflowRoute(
			poolPages(busyPool(5), "95"),
			{ GITHUB_EVENT_NAME: "push" },
		);
		assert.deepEqual([decision.tier, decision.runner], ["fleet", "hobo-trunk"]);
		assert.doesNotMatch(decision.reason, /hobo pool/u);
		assert.ok(
			!warningsIn(lines).some((line) =>
				line.includes(AGENT37_OVERFLOW_RUNNER_LABEL),
			),
			lines.join("\n"),
		);
	});

	it("keeps an explicitly pinned fleet on the fleet without reading the pool", async () => {
		const decision = await main(
			["--route", "fleet"],
			{
				GITHUB_EVENT_NAME: "pull_request",
				GITHUB_API_URL: "http://127.0.0.1:9",
			},
			NO_SLIP_CALL,
		);
		assert.deepEqual([decision.tier, decision.runner], ["fleet", "hobo"]);
		assert.doesNotMatch(decision.reason, /hobo pool/u);
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
			const actionDir = join(dir, ".github/actions/route-runner");
			mkdirSync(actionDir, { recursive: true });
			writeFileSync(output, "");
			const run = spawnSync("bash", ["-c", expressions], {
				cwd: dir,
				encoding: "utf8",
				env: {
					PATH: process.env.PATH ?? "",
					GITHUB_OUTPUT: output,
					GITHUB_EVENT_NAME: "push",
					GITHUB_ACTION_PATH: actionDir,
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
			/"\$\{action_root\}\/scripts\/ci\/route-runner\.mts" \\\n\s+--route "\$\{route\}" --include-own-run "\$\{include_own_run\}" --attested "\$\{attested\}"/,
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
		.filter((path) => {
			const text = read(path);
			return (
				text.includes("uses: $/.github/actions/route-runner") ||
				text.includes("uses: ./.github/actions/route-runner") ||
				text.includes("uses: ./.ci-trusted/.github/actions/route-runner")
			);
		});

	// A file the script loads and a workflow does not check out stops the
	// script before it decides, and the step then falls back to GitHub-hosted.
	it("check out every file the routing script loads", () => {
		const needed = loadedBy("scripts/ci/route-runner.mts");
		assert.deepEqual([...needed].sort(), [
			"packages/ci/src/fleet-overflow.ts",
			"scripts/ci/route-runner.mts",
			"scripts/ci/runner-routing.mts",
		]);
		assert.deepEqual([...routed].sort(), [
			".github/workflows/hobo-ci.yml",
			".github/workflows/pricing-ci.yml",
			".github/workflows/relay-deploy.yml",
			".github/workflows/release-hobo.yml",
			".github/workflows/release-pricing.yml",
			".github/workflows/release-ts-autocode.yml",
		]);
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
		assert.match(
			ci,
			/id: route\n\s+uses: .*route-runner\n\s+with:\n\s+token: \$\{\{ github\.token \}\}\n\s+route: \$\{\{ \(inputs\.route \|\| 'auto'\) \}\}/,
		);
		assert.match(
			ci,
			/Ask again before the shards[\s\S]*?id: reroute[\s\S]*?uses: .*route-runner[\s\S]*?route: \$\{\{ inputs\.route \|\| 'auto' \}\}[\s\S]*?include-own-run: "true"/,
		);
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
