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
	askRelay,
	BURST_SECONDS,
	chooseRunner,
	DEFAULT_MAX_QUEUED,
	DEFAULT_MAX_WAIT_SECONDS,
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
	observeQueue,
	PROBE_POLL_SECONDS,
	PROBE_WAIT_SECONDS,
	PROBE_WORKFLOW_PATH,
	parseFleetVerdict,
	parseRelayOrigin,
	parseRouteMode,
	probeRunIds,
	type QueueView,
	RECENT_PICKUP_SECONDS,
	RELAY_CONFIG_PATH,
	RELAY_VERDICT_TIMEOUT_SECONDS,
	type RelayAnswer,
	type RouteDecision,
	refusingJobs,
	relayRefusal,
	routeAnnotation,
	routeRunner,
	runsJustAhead,
	type SeenJob,
	SLOW_PICKUP_MEMORY_SECONDS,
	STALE_WAIT_SECONDS,
	seenJobs,
	slowestFinishedRunIds,
	takingJobs,
	unfinishedRunIds,
	workflowFile,
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

/** The relay's verdict contract, as its provider suite verifies it. */
const verdictPact: {
	interactions: {
		description: string;
		request: { method: string; path: string };
		response: { status: number; body: JsonValue };
	}[];
} = JSON.parse(
	readFileSync(
		new URL(
			"../../packages/ci-gh-actions/contracts/fleet-verdict-boundary.pact.json",
			import.meta.url,
		),
		"utf8",
	),
);
const pactAnswer = (description: string) => {
	const found = verdictPact.interactions.find((entry) =>
		entry.description.startsWith(description),
	);
	assert.ok(found, `the Pact has no interaction "${description}"`);
	return found;
};
/** A verdict that blocks these labels. */
const verdict = (blocked: Record<string, string> = {}): RelayAnswer => ({
	kind: "verdict",
	blocked: new Map(Object.entries(blocked)),
});
const NO_NODE = verdict({ hobo: "no-node" });
const NO_CAPACITY = verdict({ hobo: "no-capacity" });
const OPEN = verdict();

describe("the relay the project names", () => {
	const project = (environment: Record<string, string | boolean>) =>
		JSON.stringify({
			defaultEnvironment: "ci",
			environments: { ci: environment, other: { relayOrigin: "https://x.y" } },
		});

	it("is the default environment's relay origin", () => {
		assert.equal(
			parseRelayOrigin(project({ relayOrigin: "https://relay.example/" })),
			"https://relay.example",
		);
	});

	it("is HoBo's hosted relay in this repository", () => {
		assert.equal(
			parseRelayOrigin(
				readFileSync(
					new URL(`../../${RELAY_CONFIG_PATH}`, import.meta.url),
					"utf8",
				),
			),
			"https://hobo-ci.vercel.app",
		);
	});

	it("is nothing when the file is missing, unreadable or names none", () => {
		for (const text of [
			undefined,
			"",
			"not json",
			"[]",
			"{}",
			JSON.stringify({ defaultEnvironment: "ci", environments: {} }),
			project({}),
			project({ relayOrigin: "not a url" }),
		])
			assert.equal(parseRelayOrigin(text), undefined, String(text));
	});

	it("must be https, but for a loopback relay the environment allows", () => {
		assert.equal(
			parseRelayOrigin(project({ relayOrigin: "http://relay.example" })),
			undefined,
		);
		assert.equal(
			parseRelayOrigin(project({ relayOrigin: "http://127.0.0.1:8787" })),
			undefined,
		);
		assert.equal(
			parseRelayOrigin(
				project({
					relayOrigin: "http://127.0.0.1:8787",
					allowInsecureLoopback: true,
				}),
			),
			"http://127.0.0.1:8787",
		);
		assert.equal(
			parseRelayOrigin(
				project({
					relayOrigin: "http://relay.example",
					allowInsecureLoopback: true,
				}),
			),
			undefined,
		);
		assert.equal(
			parseRelayOrigin(
				project({ relayOrigin: "https://user:key@relay.example" }),
			),
			undefined,
		);
	});
});

describe("the relay's verdict", () => {
	it("is read from the answers the relay's contract pins", () => {
		// Routing is the consumer of these two answers; the relay's provider
		// suite proves it gives them.
		const standing = pactAnswer("answer the standing verdict");
		assert.deepEqual(
			[...(parseFleetVerdict(standing.response.body, "Hobo-Labs/HoBo") ?? [])],
			[
				["hobo", "no-capacity"],
				["hobo-trunk", "no-node"],
			],
		);
		const none = pactAnswer("answer a repository with no verdict");
		assert.equal(
			parseFleetVerdict(none.response.body, "hobo-labs/hobo")?.size,
			0,
		);
	});

	it("is not read from an answer about another repository, or one that is not the record", () => {
		const answers: readonly JsonValue[] = [
			null,
			"blocked",
			[],
			{},
			{ repository: "hobo-labs/hobo" },
			{ repository: "hobo-labs/hobo", blocked: [] },
			{ repository: "hobo-labs/hobo", blocked: { hobo: "no-node" } },
			{ repository: "hobo-labs/hobo", blocked: { hobo: {} } },
			{ repository: "hobo-labs/hobo", blocked: { hobo: { reason: 7 } } },
			// A reason is printed in the job's log: only a short plain token is one.
			{
				repository: "hobo-labs/hobo",
				blocked: { hobo: { reason: "no-node\n::error::owned" } },
			},
			{ repository: "acme/app", blocked: { hobo: { reason: "no-node" } } },
		];
		for (const answer of answers)
			assert.equal(
				parseFleetVerdict(answer, "hobo-labs/hobo"),
				undefined,
				JSON.stringify(answer),
			);
	});

	it("still blocks for a reason this reader has not seen", () => {
		const blocked = parseFleetVerdict(
			{ repository: "a/b", blocked: { hobo: { reason: "draining" } } },
			"a/b",
		);
		assert.match(
			relayRefusal(
				{ kind: "verdict", blocked: blocked ?? new Map() },
				"hobo",
			) ?? "",
			/the relay keeps new work off hobo: draining/,
		);
	});

	it("refuses only a label it names", () => {
		const answer = verdict({ hobo: "no-capacity", "hobo-trunk": "no-node" });
		assert.equal(
			relayRefusal(answer, "hobo"),
			"the relay keeps new work off hobo: no node can admit a job and none has a free slot",
		);
		assert.equal(
			relayRefusal(answer, "HOBO-TRUNK"),
			"the relay keeps new work off HOBO-TRUNK: no live node serves it",
		);
		assert.equal(relayRefusal(answer, "hobo-local-host"), undefined);
		for (const other of [
			undefined,
			OPEN,
			{ kind: "unasked" },
			{ kind: "unanswered", why: "it could not be reached" },
		] as const)
			assert.equal(relayRefusal(other, "hobo"), undefined);
	});
});

describe("asking the relay", () => {
	const ask = (
		respond: (url: string, init: RequestInit) => Promise<Response> | Response,
		target: { origin?: string | undefined; repository?: string } = {
			origin: "https://relay.example",
		},
	) =>
		askRelay({
			origin: target.origin,
			repository: target.repository ?? "Hobo-Labs/HoBo",
			fetch: async (url, init) => respond(String(url), init ?? {}),
		});

	it("gets the repository's verdict from the relay, sending no credential", async () => {
		const standing = pactAnswer("answer the standing verdict");
		const asked: { url: string; init: RequestInit }[] = [];
		const answer = await ask((url, init) => {
			asked.push({ url, init });
			return Response.json(standing.response.body);
		});
		assert.equal(answer.kind, "verdict");
		assert.equal(
			answer.kind === "verdict" && answer.blocked.get("hobo"),
			"no-capacity",
		);
		assert.equal(asked.length, 1);
		assert.equal(
			asked[0]?.url,
			"https://relay.example/v1/fleet/verdicts/Hobo-Labs/HoBo",
		);
		assert.deepEqual(Object.fromEntries(new Headers(asked[0]?.init.headers)), {
			accept: "application/json",
		});
		assert.equal(asked[0]?.init.redirect, "error");
	});

	it("does not ask when no relay is named, or the repository is not one", async () => {
		const never = () => {
			throw new Error("nothing should be asked");
		};
		const origin = "https://relay.example";
		for (const target of [
			{ origin: undefined },
			{ origin, repository: "" },
			{ origin, repository: "a/b/../c" },
			{ origin, repository: "a/b?x=1" },
			// Longer than any owner GitHub has: the relay would answer 404.
			{ origin, repository: `${"a".repeat(40)}/b` },
		])
			assert.deepEqual(await ask(never, target), { kind: "unasked" });
	});

	it("asks for a managed user's repository, underscore and all", async () => {
		const asked: string[] = [];
		await ask(
			(url) => {
				asked.push(url);
				return Response.json({ repository: "mona_corp/app", blocked: {} });
			},
			{ origin: "https://relay.example", repository: "Mona_Corp/App" },
		);
		assert.deepEqual(asked, [
			"https://relay.example/v1/fleet/verdicts/Mona_Corp/App",
		]);
	});

	it("drops the body of an answer it will not read, so nothing holds the job open", async () => {
		let cancelled = false;
		const answer = await ask(
			() =>
				new Response(
					new ReadableStream({
						cancel() {
							cancelled = true;
						},
					}),
					{ status: 503 },
				),
		);
		assert.deepEqual(answer, { kind: "unanswered", why: "it answered 503" });
		assert.equal(cancelled, true);
	});

	it("reads any failure as no verdict, and says which", async () => {
		assert.deepEqual(
			await ask(() =>
				Response.json({ error: "service unavailable" }, { status: 503 }),
			),
			{ kind: "unanswered", why: "it answered 503" },
		);
		assert.deepEqual(await ask(() => new Response("<html>")), {
			kind: "unanswered",
			why: "its answer was not a verdict",
		});
		assert.deepEqual(await ask(() => Response.json({ blocked: 1 })), {
			kind: "unanswered",
			why: "its answer was not a verdict",
		});
		assert.deepEqual(
			await ask(() => {
				throw new TypeError("fetch failed");
			}),
			{ kind: "unanswered", why: "it could not be reached" },
		);
		assert.deepEqual(
			await ask(() => {
				throw new DOMException("timed out", "TimeoutError");
			}),
			{
				kind: "unanswered",
				why: `it did not answer in ${RELAY_VERDICT_TIMEOUT_SECONDS} s`,
			},
		);
	});

	it("gives up on a relay that does not answer in time", async () => {
		assert.equal(RELAY_VERDICT_TIMEOUT_SECONDS, 3);
		// The timeout's own timer does not hold the process open; this does.
		const awake = setTimeout(() => {}, 10_000);
		const answer = await ask(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					assert.ok(init.signal);
					init.signal.addEventListener("abort", () =>
						reject(init.signal?.reason),
					);
				}),
		);
		clearTimeout(awake);
		assert.deepEqual(answer, {
			kind: "unanswered",
			why: "it did not answer in 3 s",
		});
	});
});

describe("the routing decision with the relay's verdict", () => {
	it("leaves a fleet the relay keeps work off at once, though the queue shows it taking jobs", () => {
		assert.equal(decide().tier, "fleet");
		const routed = decide({ relay: NO_CAPACITY });
		assert.equal(routed.tier, "github");
		assert.equal(routed.runner, "ubuntu-24.04");
		assert.match(routed.reason, /the fleet has nothing waiting/);
		assert.match(
			routed.reason,
			/the relay keeps new work off hobo: no node can admit a job and none has a free slot/,
		);
	});

	it("leaves a fleet with no live node at once", () => {
		const routed = decide({ relay: NO_NODE });
		assert.equal(routed.tier, "github");
		assert.match(routed.reason, /no live node serves it/);
	});

	it("judges the label this run would ask for", () => {
		const answer = verdict({ "hobo-trunk": "no-node" });
		assert.equal(decide({ relay: answer }).tier, "fleet");
		assert.equal(
			decide({ fleetLabel: "hobo-trunk", relay: answer }).tier,
			"github",
		);
		assert.deepEqual(
			decide({ fleetLabel: "hobo-trunk", relay: NO_NODE }),
			decide({ fleetLabel: "hobo-trunk" }),
		);
	});

	it("never makes a fleet look available: a verdict that blocks nothing does not outvote the queue", () => {
		assert.deepEqual(decide({ relay: OPEN }), decide());
		for (const fleet of [
			idle,
			{ ...up, queued: 4 },
			{ ...up, oldestWaitSeconds: 900, queued: 1 },
		])
			assert.deepEqual(decide({ fleet, relay: OPEN }), decide({ fleet }));
		assert.deepEqual(
			decide({ undecidedAhead: 2, relay: OPEN }),
			decide({ undecidedAhead: 2 }),
		);
	});

	it("decides as without a relay when it was not asked", () => {
		for (const load of [{}, { fleet: idle }, { fleet: { ...up, queued: 4 } }])
			assert.deepEqual(
				decide({ ...load, relay: { kind: "unasked" } }),
				decide(load),
			);
	});

	it("decides as without a relay when it gave no verdict, and says it did not", () => {
		const relay = { kind: "unanswered", why: "it answered 503" } as const;
		for (const load of [{}, { fleet: idle }, { fleet: { ...up, queued: 4 } }]) {
			const routed = decide({ ...load, relay });
			const alone = decide(load);
			assert.deepEqual(
				[routed.tier, routed.runner],
				[alone.tier, alone.runner],
			);
			assert.match(
				routed.reason,
				/the relay gave no verdict \(it answered 503\)/,
			);
		}
	});

	it("passes over a local box the relay keeps work off, and one it does not name is judged by the queue", () => {
		const local = {
			localEnrolled: true,
			fleet: { ...up, queued: 4 },
		};
		assert.equal(decide({ ...local, relay: OPEN }).tier, "local");
		assert.equal(
			decide({ ...local, relay: verdict({ "hobo-local-host": "no-node" }) })
				.tier,
			"github",
		);
	});

	it("goes to the local box when the relay keeps work off the fleet", () => {
		const routed = decide({ localEnrolled: true, relay: NO_CAPACITY });
		assert.equal(routed.tier, "local");
	});

	it("does not move a pinned tier", () => {
		assert.equal(decide({ mode: "fleet", relay: NO_NODE }).runner, "hobo");
		assert.equal(
			decide({ mode: "local", relay: NO_NODE }).runner,
			"hobo-local-host",
		);
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
			/** What the relay answers on each look; the last one repeats. */
			relay?: readonly RelayAnswer[];
		} = {},
	) => {
		let clock = NOW;
		let looks = 0;
		let asked = 0;
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
			askRelay: async () => {
				const answers = overrides.relay ?? [{ kind: "unasked" } as const];
				asked += 1;
				const answer = answers[Math.min(asked, answers.length) - 1];
				assert.ok(answer);
				return answer;
			},
		});
		return { decision, looks, asked, waited: (clock - NOW) / 1000 };
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

	it("does not wait for the probe on a fleet the relay keeps work off", async () => {
		// A probe being picked up would not change what the relay decided.
		const seen = await choose([probing], { relay: [NO_CAPACITY] });
		assert.deepEqual([seen.decision.tier, seen.waited], ["github", 0]);
		assert.match(seen.decision.reason, /the relay keeps new work off hobo/);
	});

	it("waits for the probe as before when the relay blocks nothing, or gave no verdict", async () => {
		for (const answer of [
			OPEN,
			{ kind: "unanswered", why: "it could not be reached" } as const,
		]) {
			const seen = await choose([probing, probing, answered], {
				relay: [answer],
			});
			assert.equal(seen.decision.tier, "fleet");
			assert.equal(seen.waited, 2 * PROBE_POLL_SECONDS);
		}
	});

	it("asks the relay afresh on every look, not once", async () => {
		// Nothing blocked at first, so the probe is waited on; then the relay
		// keeps work off the fleet, and the wait ends there.
		const seen = await choose([probing, probing, answered], {
			relay: [OPEN, NO_NODE],
		});
		assert.deepEqual(
			[seen.decision.tier, seen.looks, seen.asked],
			["github", 2, 2],
		);
		assert.equal(seen.waited, PROBE_POLL_SECONDS);
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

/** A project file naming a relay, as `.hobo/ci.json` does. */
const RELAY_CONFIG = JSON.stringify({
	defaultEnvironment: "ci",
	environments: { ci: { relayOrigin: "https://relay.example" } },
});

/**
 * A named relay that must not be called: these decisions are made without
 * it, and without this a mistake would ask the real relay `.hobo/ci.json` names.
 */
const NO_RELAY_CALL = {
	relayConfig: RELAY_CONFIG,
	fetch: async (): Promise<never> => {
		throw new Error("the relay must not be asked here");
	},
};

describe("the script as a whole", () => {
	it("uses GitHub-hosted, and says why, when the queue cannot be read", async () => {
		const decision = await main(
			{
				GITHUB_EVENT_NAME: "merge_group",
				GITHUB_REPOSITORY: "acme/app",
				GITHUB_RUN_ID: "1",
				GITHUB_API_URL: "http://127.0.0.1:9",
			},
			NO_RELAY_CALL,
		);
		assert.equal(decision.runner, "ubuntu-24.04");
		assert.equal(decision.tier, "github");
		assert.match(decision.reason, /could not be read/);
	});

	it("does not read the queue for a pinned tier", async () => {
		const pinned = await main(
			{
				GITHUB_EVENT_NAME: "merge_group",
				HOBO_CI_ROUTE: "fleet",
				GITHUB_API_URL: "http://127.0.0.1:9",
			},
			NO_RELAY_CALL,
		);
		assert.equal(pinned.runner, "hobo-trunk");
		const hosted = await main(
			{
				GITHUB_EVENT_NAME: "pull_request",
				HOBO_CI_ROUTE: "github",
				GITHUB_API_URL: "http://127.0.0.1:9",
			},
			NO_RELAY_CALL,
		);
		assert.equal(hosted.runner, "ubuntu-24.04");
	});

	it("keeps a pinned fleet on the fleet without asking the relay", async () => {
		const pinned = await main(
			{
				GITHUB_EVENT_NAME: "pull_request",
				GITHUB_REPOSITORY: "acme/app",
				HOBO_CI_ROUTE: "fleet",
				GITHUB_API_URL: "http://127.0.0.1:9",
			},
			NO_RELAY_CALL,
		);
		assert.deepEqual([pinned.tier, pinned.runner], ["fleet", "hobo"]);
	});

	it("sends what is left of an attested run to GitHub-hosted without reading the queue", async () => {
		const attested = await main(
			{
				GITHUB_EVENT_NAME: "merge_group",
				HOBO_CI_ATTESTED: "true",
				GITHUB_API_URL: "http://127.0.0.1:9",
			},
			NO_RELAY_CALL,
		);
		assert.equal(attested.runner, "ubuntu-24.04");
		assert.equal(attested.tier, "github");
		assert.match(attested.reason, /signed local run/);
		// A pin is an operator's override: it still wins.
		const pinned = await main(
			{
				GITHUB_EVENT_NAME: "merge_group",
				HOBO_CI_ATTESTED: "true",
				HOBO_CI_ROUTE: "fleet",
				GITHUB_API_URL: "http://127.0.0.1:9",
			},
			NO_RELAY_CALL,
		);
		assert.equal(pinned.runner, "hobo-trunk");
		// Anything but the literal `true` is not an attestation.
		const unattested = await main(
			{
				GITHUB_EVENT_NAME: "pull_request",
				HOBO_CI_ATTESTED: "false",
				GITHUB_REPOSITORY: "acme/app",
				GITHUB_RUN_ID: "1",
				GITHUB_API_URL: "http://127.0.0.1:9",
			},
			NO_RELAY_CALL,
		);
		assert.match(unattested.reason, /could not be read/);
	});
});

describe("the script asking the relay", () => {
	/** GitHub's queue with a runner that took the probe's `hobo` job a minute ago. */
	const withFleetUp = async <T>(run: (apiUrl: string) => Promise<T>) => {
		const ago = (seconds: number) =>
			new Date(Date.now() - seconds * 1000).toISOString();
		const server = createServer((request, response) => {
			const page = request.url?.includes("/jobs")
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
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify(page));
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
	const route = (
		apiUrl: string,
		relay: (url: string) => Response,
		project: { relayConfig: string | undefined } = {
			relayConfig: RELAY_CONFIG,
		},
	) => {
		const asked: string[] = [];
		return main(
			{
				GITHUB_EVENT_NAME: "pull_request",
				GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
				GITHUB_RUN_ID: "51",
				GITHUB_API_URL: apiUrl,
			},
			{
				relayConfig: project.relayConfig,
				fetch: async (url) => {
					asked.push(String(url));
					return relay(String(url));
				},
			},
		).then((decision) => ({ decision, asked }));
	};

	it("leaves the fleet when the relay it asked keeps work off the run's label", async () => {
		await withFleetUp(async (apiUrl) => {
			const standing = pactAnswer("answer the standing verdict");
			const { decision, asked } = await route(apiUrl, () =>
				Response.json(standing.response.body),
			);
			assert.deepEqual(asked, [
				"https://relay.example/v1/fleet/verdicts/Hobo-Labs/HoBo",
			]);
			assert.deepEqual(
				[decision.tier, decision.runner],
				["github", "ubuntu-24.04"],
			);
			assert.match(decision.reason, /the relay keeps new work off hobo/);
		});
	});

	it("stays on the fleet when the relay blocks nothing", async () => {
		await withFleetUp(async (apiUrl) => {
			const none = pactAnswer("answer a repository with no verdict");
			const { decision } = await route(apiUrl, () =>
				Response.json(none.response.body),
			);
			assert.equal(decision.tier, "fleet");
			assert.doesNotMatch(decision.reason, /relay/);
		});
	});

	it("stays on the fleet, and says the relay gave no verdict, when it fails", async () => {
		await withFleetUp(async (apiUrl) => {
			const { decision } = await route(apiUrl, () =>
				Response.json({ error: "service unavailable" }, { status: 503 }),
			);
			assert.equal(decision.tier, "fleet");
			assert.match(
				decision.reason,
				/the relay gave no verdict \(it answered 503\)/,
			);
		});
	});

	it("asks no one when the project names no relay", async () => {
		await withFleetUp(async (apiUrl) => {
			const { decision, asked } = await route(
				apiUrl,
				() => {
					throw new Error("no relay is named");
				},
				{ relayConfig: undefined },
			);
			assert.deepEqual(asked, []);
			assert.equal(decision.tier, "fleet");
		});
	});

	it("takes nothing about the fleet from the environment", async () => {
		// What a worker once published for routing, handed over the old way.
		await withFleetUp(async (apiUrl) => {
			const decision = await main(
				{
					GITHUB_EVENT_NAME: "pull_request",
					GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
					GITHUB_RUN_ID: "51",
					GITHUB_API_URL: apiUrl,
					HOBO_CI_FLEET_STATE: JSON.stringify({
						publishedAt: new Date().toISOString(),
						labels: { hobo: { nodes: 0, trustedNodes: 0, freeSlots: 0 } },
					}),
					HOBO_CI_FLEET_CAPACITY: JSON.stringify({
						version: 1,
						admittedParallel: 0,
						hobo: { freeSlots: 0 },
						arc: { freeSlots: 0 },
						trunkMemoryAdmit: false,
						publishedAt: new Date().toISOString(),
					}),
				},
				{ relayConfig: undefined },
			);
			assert.equal(decision.tier, "fleet");
		});
	});

	/** The `hobo-ci-route` notice a decision should print, field by field. */
	const notice = (fields: {
		workflow?: string;
		tier: string;
		runner: string;
		relay: string;
		why: string;
		refusedBy: string;
	}) =>
		`::notice title=hobo-ci-route::${JSON.stringify({
			v: 1,
			workflow: fields.workflow ?? "",
			tier: fields.tier,
			runner: fields.runner,
			relay: fields.relay,
			why: fields.why,
			refusedBy: fields.refusedBy,
		})}`;
	/** The `hobo-ci-route` notices the script printed. */
	const noticesOf = async (
		run: () => Promise<RouteDecision | Readonly<{ decision: RouteDecision }>>,
	): Promise<string[]> => {
		const printed: string[] = [];
		const log = console.log;
		console.log = (...parts: unknown[]) => {
			printed.push(parts.map(String).join(" "));
		};
		try {
			await run();
		} finally {
			console.log = log;
		}
		return printed.filter((line) =>
			line.startsWith("::notice title=hobo-ci-route::"),
		);
	};
	const hosted = { tier: "github", runner: "ubuntu-24.04" };
	const fleet = { tier: "fleet", runner: "hobo" };

	it("annotates a decision the relay's verdict made", async () => {
		await withFleetUp(async (apiUrl) => {
			const standing = pactAnswer("answer the standing verdict");
			assert.deepEqual(
				await noticesOf(() =>
					route(apiUrl, () => Response.json(standing.response.body)),
				),
				[notice({ ...hosted, relay: "verdict", why: "", refusedBy: "relay" })],
			);
		});
	});

	it("annotates a relay that gave no verdict, and why", async () => {
		await withFleetUp(async (apiUrl) => {
			assert.deepEqual(
				await noticesOf(() =>
					route(apiUrl, () =>
						Response.json({ error: "service unavailable" }, { status: 503 }),
					),
				),
				[
					notice({
						...fleet,
						relay: "unanswered",
						why: "it answered 503",
						refusedBy: "none",
					}),
				],
			);
		});
	});

	it("annotates why the relay was not asked", async () => {
		await withFleetUp(async (apiUrl) => {
			assert.deepEqual(
				await noticesOf(() =>
					route(apiUrl, () => Response.json({}), { relayConfig: undefined }),
				),
				[
					notice({
						...fleet,
						relay: "unasked",
						why: "no-relay",
						refusedBy: "none",
					}),
				],
			);
		});
		const env = {
			GITHUB_EVENT_NAME: "push",
			GITHUB_API_URL: "http://127.0.0.1:9",
			GITHUB_WORKFLOW_REF:
				"Hobo-Labs/HoBo/.github/workflows/hobo-ci.yml@refs/heads/main",
		};
		const unasked = (why: string, refusedBy: string) => [
			notice({
				workflow: "hobo-ci.yml",
				...hosted,
				relay: "unasked",
				why,
				refusedBy,
			}),
		];
		assert.deepEqual(
			await noticesOf(() =>
				main({ ...env, HOBO_CI_ROUTE: "github" }, NO_RELAY_CALL),
			),
			unasked("pinned", "none"),
		);
		assert.deepEqual(
			await noticesOf(() =>
				main({ ...env, HOBO_CI_ATTESTED: "true" }, NO_RELAY_CALL),
			),
			unasked("attested", "none"),
		);
		assert.deepEqual(
			await noticesOf(() =>
				main(
					{ ...env, GITHUB_REPOSITORY: "acme/app", GITHUB_RUN_ID: "1" },
					NO_RELAY_CALL,
				),
			),
			unasked("queue-unread", "queue"),
		);
	});
});

describe("the route notice", () => {
	it("is one line a workflow command cannot cut short", () => {
		const line = routeAnnotation(
			{
				tier: "fleet",
				runner: "hobo",
				reason: "",
				relay: { kind: "unanswered", why: "100% down\nnext" },
			},
			"hobo-ci.yml",
			"no-relay",
		);
		assert.doesNotMatch(line, /\n|\r/);
		assert.match(line, /^::notice title=hobo-ci-route::\{"v":1,/);
		assert.match(line, /100%25 down/);
		assert.match(line, /"refusedBy":"none"/);
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
			// The relay blocked nothing: the default minimum of one free runner.
			askRelay: async () => ({ kind: "verdict", blocked: new Map() }),
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
	/** Runs the step where the routing script was not checked out (finding 143). */
	const fallBack = (env: Record<string, string>) => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-route-fallback-"));
		try {
			const output = join(dir, "output");
			writeFileSync(output, "");
			const run = spawnSync("bash", ["-c", script], {
				cwd: dir,
				encoding: "utf8",
				env: {
					PATH: process.env.PATH ?? "",
					GITHUB_OUTPUT: output,
					GITHUB_EVENT_NAME: "push",
					HOBO_CI_ROUTE: "",
					HOBO_CI_TRUNK_RUNNER: "",
					HOBO_CI_INCLUDE_OWN_RUN: "",
					...env,
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
		assert.equal(output, "runner=ubuntu-24.04\ntier=github\n");
	});

	it("names the fallback and keeps a pinned fleet on the fleet", () => {
		const { stdout, output } = fallBack({ HOBO_CI_ROUTE: "fleet" });
		assert.match(stdout, WARNING);
		assert.equal(output, "runner=hobo-trunk\ntier=fleet\n");
	});

	it("names the fallback and outputs nothing on a second ask, so the run's route stands", () => {
		const { stdout, output } = fallBack({ HOBO_CI_INCLUDE_OWN_RUN: "true" });
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

	it("check out the file that names the relay", () => {
		for (const path of routed)
			assert.ok(
				read(path)
					.split("\n")
					.some((line) => line.trim() === RELAY_CONFIG_PATH),
				`${path} does not sparse-checkout ${RELAY_CONFIG_PATH}`,
			);
	});

	it("hand the routing step nothing about the fleet", () => {
		// The relay is asked at decision time; no input or variable carries
		// what the fleet can take.
		const action = read(".github/actions/route-runner/action.yml");
		for (const path of [".github/actions/route-runner/action.yml", ...routed])
			assert.doesNotMatch(
				read(path),
				/fleet-state|fleet-capacity|HOBO_CI_FLEET_(STATE|CAPACITY|ROUTES)/,
				path,
			);
		assert.match(action, /scripts\/ci\/route-runner\.mts/);
	});
});
