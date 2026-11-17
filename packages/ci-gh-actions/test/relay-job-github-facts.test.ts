import { readFileSync } from "node:fs";
import { answerRelayJob, providerHealthKey, relayRouteRequest } from "@hobo/ci";
import {
	InMemoryRouteJournal,
	InMemoryRunnerOrderSource,
	routeFactsSourceConformance,
	testRelayJobMessage,
	testRouteRequest,
} from "@hobo/ci/runner-order/testing";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
	GITHUB_FACTS_MAX_CALLS,
	GITHUB_FACTS_WARNING_TITLE,
	GithubRouteFacts,
} from "../src/relay-job/github-facts.js";
import { routingSlipJson } from "../src/routing-slip.js";

const API = "https://api.github.test";
const REPO = "octo/app";
const OWN_RUN = 5000;
const MINUTE = 60_000;
const NOW = Date.parse("2026-11-17T12:00:00Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const ago = (minutes: number): string => iso(NOW - minutes * MINUTE);

type FakeJob = Readonly<{
	label: string;
	queued: number;
	started?: number;
	status?: string;
}>;
type FakeRun = Readonly<{
	id: number;
	created: number;
	finished?: boolean;
	jobs: readonly FakeJob[];
}>;

const SLIP_LABELS = new Set([
	"hobo",
	"hobo-trunk",
	"hobo-local-host",
	"ubuntu-24.04",
]);
const SLIP_SHA = "a".repeat(40);

function slipText(
	fleet: "fleet-open" | "fleet-busy" | "no-capacity",
	forkToFleet = false,
	fleetRunner = "hobo",
): string {
	const route =
		fleet === "no-capacity"
			? { runner: "ubuntu-24.04", tier: "github" as const, reason: fleet }
			: { runner: fleetRunner, tier: "fleet" as const, reason: fleet };
	return routingSlipJson(
		{
			repository: REPO,
			issuedAtMs: NOW - MINUTE,
			classes: {
				pr: route,
				trunk: route,
				fork: forkToFleet
					? { runner: "hobo", tier: "fleet", reason: "fleet-open" }
					: { runner: "ubuntu-24.04", tier: "github", reason: "no-capacity" },
			},
			relay: { nodeId: "box-1", commit: "abcdef1" },
		},
		SLIP_LABELS,
	);
}

type Answer = Readonly<{ status: number; body: string }>;
type JsonBody = z.infer<ReturnType<typeof z.json>>;
/** A fake GitHub: its `fetch`, and every path asked of it. */
type FakeGithub = Readonly<{ fetch: typeof fetch; asked: string[] }>;
const json = (body: JsonBody, status = 200): Answer => ({
	status,
	body: JSON.stringify(body),
});

/** GitHub's REST answers for a queue of runs, and every path asked for. */
function fakeGithub(
	runs: readonly FakeRun[],
	options: Readonly<{
		slip?: string;
		fail?: string;
		hang?: boolean;
	}> = {},
): FakeGithub {
	const asked: string[] = [];
	const routes = new Map<string, Answer>();
	routes.set(
		`/repos/${REPO}/git/ref/hobo/routing-slip`,
		options.slip === undefined
			? json({ message: "Not Found" }, 404)
			: json({ object: { sha: SLIP_SHA, type: "commit" } }),
	);
	if (options.slip !== undefined)
		routes.set(
			`/repos/${REPO}/git/commits/${SLIP_SHA}`,
			json({ sha: SLIP_SHA, message: options.slip }),
		);
	const all: FakeRun[] = [{ id: OWN_RUN, created: 0, jobs: [] }, ...runs];
	routes.set(
		`/repos/${REPO}/actions/runs?per_page=100`,
		json({
			workflow_runs: all.map((run) => ({
				id: run.id,
				status: run.finished ? "completed" : "in_progress",
				path: ".github/workflows/ci.yml",
				created_at: ago(run.created),
				updated_at: ago(run.finished ? 0 : run.created),
			})),
		}),
	);
	for (const run of all)
		routes.set(
			`/repos/${REPO}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
			json({
				jobs: run.jobs.map((job) => ({
					run_id: run.id,
					status:
						job.status ??
						(job.started === undefined ? "queued" : "in_progress"),
					labels: [job.label],
					created_at: ago(job.queued),
					started_at: ago(job.started ?? job.queued),
					runner_name: job.started === undefined ? null : "runner-1",
				})),
			}),
		);
	const fake = async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const url = String(input);
		const path = url.slice(API.length);
		asked.push(path);
		if (options.hang)
			return new Promise((_, reject) =>
				init?.signal?.addEventListener("abort", () =>
					reject(init.signal?.reason),
				),
			);
		if (options.fail && path.includes(options.fail))
			return new Response("boom", { status: 502 });
		const answer = routes.get(path) ?? json({ message: "Not Found" }, 404);
		return new Response(answer.body, { status: answer.status });
	};
	return { fetch: fake, asked };
}

function facts(
	runs: readonly FakeRun[],
	options: Parameters<typeof fakeGithub>[1] = {},
	budgetMs?: number,
) {
	const github = fakeGithub(runs, options);
	const source = new GithubRouteFacts({
		token: "job-token",
		apiUrl: API,
		fetch: github.fetch,
		slipLabels: SLIP_LABELS,
		budgetMs,
	});
	return { source, asked: github.asked };
}

function request(inputs: Readonly<Record<string, string>>) {
	return testRelayJobMessage({
		runId: OWN_RUN,
		inputs: Object.entries(inputs),
	});
}

async function answer(
	order: string,
	inputs: Readonly<Record<string, string>>,
	source: GithubRouteFacts,
) {
	return answerRelayJob(request(inputs), {
		order: new InMemoryRunnerOrderSource(new Map([[REPO, order]])),
		facts: source,
		journal: new InMemoryRouteJournal(),
		nowMs: NOW,
		mode: "job",
		node: "relay-job",
		accountId: "acct-1",
		checks: undefined,
	});
}

const outputs = (result: Awaited<ReturnType<typeof answer>>) =>
	new Map(result.outputs.map((value) => [value.name, value.value]));

describe("GithubRouteFacts keeps the facts port's rules", () => {
	it("passes the conformance function with an empty queue", async () => {
		await routeFactsSourceConformance(() => facts([]).source);
	});

	it("passes it when every read fails", async () => {
		await routeFactsSourceConformance(
			() => facts([], { fail: "/repos/" }).source,
		);
	});
});

describe("fleet facts from the slip and the queue", () => {
	const fleetRequest = () => testRouteRequest(REPO, OWN_RUN);

	it("leaves the fleet off with no slip and no pickup seen", async () => {
		const { source } = facts([]);
		const read = await source.facts(fleetRequest(), NOW);
		expect(read.fleet).toEqual({
			enabled: false,
			taking: false,
			isolated: false,
		});
	});

	it("takes an open slip as a fleet taking jobs, isolated when forks go to it", async () => {
		const { source } = facts([], { slip: slipText("fleet-open", true) });
		const read = await source.facts(fleetRequest(), NOW);
		expect(read.fleet).toEqual({ enabled: true, taking: true, isolated: true });
	});

	it("trusts a slip only for the fleet label it names", async () => {
		// The slip issuer gives the trunk class its own label, "hobo-trunk";
		// a relay asking for "hobo" learns nothing about "hobo" from it.
		const { source } = facts([], {
			slip: slipText("fleet-open", false, "hobo-trunk"),
		});
		expect((await source.facts(fleetRequest(), NOW)).fleet).toEqual({
			enabled: false,
			taking: false,
			isolated: false,
		});
		const trunk = facts([], {
			slip: slipText("fleet-open", false, "hobo-trunk"),
		});
		const asked = await trunk.source.facts(
			relayRouteRequest(request({ fleet: "HOBO-trunk" })),
			NOW,
		);
		expect(asked.fleet).toEqual({
			enabled: true,
			taking: true,
			isolated: false,
		});
	});

	it("reads a busy slip against the queue", async () => {
		const busy = facts([], { slip: slipText("fleet-busy") });
		expect((await busy.source.facts(fleetRequest(), NOW)).fleet).toEqual({
			enabled: true,
			taking: false,
			isolated: false,
		});
		const seen = facts(
			[
				{
					id: 10,
					created: 6,
					jobs: [{ label: "hobo", queued: 6, started: 5 }],
				},
			],
			{ slip: slipText("fleet-busy") },
		);
		expect((await seen.source.facts(fleetRequest(), NOW)).fleet?.taking).toBe(
			true,
		);
	});

	it("lets the queue contradict an open slip but not a busy one", async () => {
		const fullQueue: FakeRun[] = [
			{
				id: 10,
				created: 6,
				jobs: [
					{ label: "hobo", queued: 6, started: 5 },
					...[1, 1, 1, 1].map((queued) => ({ label: "hobo", queued })),
				],
			},
		];
		const open = facts(fullQueue, { slip: slipText("fleet-open") });
		expect((await open.source.facts(fleetRequest(), NOW)).fleet?.taking).toBe(
			false,
		);
		const busy = facts(fullQueue, { slip: slipText("fleet-busy") });
		expect((await busy.source.facts(fleetRequest(), NOW)).fleet?.taking).toBe(
			true,
		);
		const none = facts(fullQueue);
		expect((await none.source.facts(fleetRequest(), NOW)).fleet?.taking).toBe(
			false,
		);
	});

	it("enables the fleet on a pickup alone and refuses it on a long wait", async () => {
		const taking = facts([
			{ id: 10, created: 6, jobs: [{ label: "hobo", queued: 6, started: 5 }] },
		]);
		expect((await taking.source.facts(fleetRequest(), NOW)).fleet).toEqual({
			enabled: true,
			taking: true,
			isolated: false,
		});
		const stuck = facts([
			{
				id: 10,
				created: 6,
				jobs: [
					{ label: "hobo", queued: 6, started: 5 },
					{ label: "hobo", queued: 3 },
				],
			},
		]);
		expect((await stuck.source.facts(fleetRequest(), NOW)).fleet?.taking).toBe(
			false,
		);
	});

	it("leaves a free fleet to a run just ahead that has not chosen yet", async () => {
		const { source } = facts([
			{ id: 10, created: 6, jobs: [{ label: "hobo", queued: 6, started: 5 }] },
			{
				id: 4999,
				created: 0.5,
				jobs: [{ label: "ubuntu-24.04", queued: 0.5 }],
			},
		]);
		const read = await source.facts(fleetRequest(), NOW);
		expect(read.fleet).toEqual({
			enabled: true,
			taking: false,
			isolated: false,
		});
	});

	it("does not hold a busy slip back for a run just ahead, as the route job does not", async () => {
		const queue: FakeRun[] = [
			{ id: 10, created: 6, jobs: [{ label: "hobo", queued: 6, started: 5 }] },
			{
				id: 4999,
				created: 0.5,
				jobs: [{ label: "ubuntu-24.04", queued: 0.5 }],
			},
		];
		const busy = facts(queue, { slip: slipText("fleet-busy") });
		expect((await busy.source.facts(fleetRequest(), NOW)).fleet?.taking).toBe(
			true,
		);
		const open = facts(queue, { slip: slipText("fleet-open") });
		expect((await open.source.facts(fleetRequest(), NOW)).fleet?.taking).toBe(
			false,
		);
	});

	it("counts a run just ahead as decided once one of its jobs finished", async () => {
		const { source } = facts([
			{ id: 10, created: 6, jobs: [{ label: "hobo", queued: 6, started: 5 }] },
			{
				id: 4999,
				created: 0.5,
				jobs: [
					{
						label: "ubuntu-24.04",
						queued: 0.5,
						started: 0.4,
						status: "completed",
					},
				],
			},
		]);
		expect((await source.facts(fleetRequest(), NOW)).fleet?.taking).toBe(true);
	});
});

describe("machine facts from the queue", () => {
	it("makes one candidate per machine label the relay names", async () => {
		const { source } = facts([
			{
				id: 10,
				created: 6,
				jobs: [{ label: "my-mac", queued: 6, started: 5 }],
			},
		]);
		const read = await source.facts(
			relayRouteRequest(request({ machine: "my-mac, gpu-box" })),
			NOW,
		);
		expect(
			read.machines.map((machine) => [
				machine.runsOn,
				machine.online,
				machine.busy,
			]),
		).toEqual([
			["my-mac", true, 0],
			["gpu-box", false, 0],
		]);
		expect(read.machines[0]?.labels).toEqual(["my-mac", "gpu-box"]);
		expect(read.machines[0]?.lastPickedAtMs).toBe(NOW - 5 * MINUTE);
	});
});

describe("R05: a busy runner is waited on, and a cancelled job frees it", () => {
	const ORDER = '{"steps":[{"key":"machine"}]}';

	it("queues the job on the machine's label while a job waits for it", async () => {
		const { source } = facts([
			{
				id: 10,
				created: 6,
				jobs: [
					{ label: "my-mac", queued: 6, started: 5 },
					{ label: "my-mac", queued: 1 },
				],
			},
		]);
		const result = await answer(ORDER, { machine: "my-mac" }, source);
		expect(result.conclusion).toBe("succeeded");
		expect(outputs(result).get("outcome")).toBe("waiting");
		expect(outputs(result).get("runner")).toBe("my-mac");
	});

	it("routes to the machine once the waiting job was cancelled", async () => {
		const { source } = facts([
			{
				id: 10,
				created: 6,
				jobs: [
					{ label: "my-mac", queued: 6, started: 5 },
					{ label: "my-mac", queued: 1, status: "completed" },
				],
			},
		]);
		const result = await answer(ORDER, { machine: "my-mac" }, source);
		expect(outputs(result).get("outcome")).toBe("routed");
		expect(outputs(result).get("runner")).toBe("my-mac");
	});

	it("does not take a job held by a concurrency group as waiting for the machine", async () => {
		const { source } = facts([
			{
				id: 10,
				created: 6,
				jobs: [
					{ label: "my-mac", queued: 6, started: 5 },
					{ label: "my-mac", queued: 1, status: "pending" },
				],
			},
		]);
		const result = await answer(ORDER, { machine: "my-mac" }, source);
		expect(outputs(result).get("outcome")).toBe("routed");
		expect(outputs(result).get("runner")).toBe("my-mac");
	});

	it("waits on a full fleet the same way", async () => {
		const { source } = facts([
			{
				id: 10,
				created: 6,
				jobs: [
					{ label: "hobo", queued: 6, started: 5 },
					...[1, 1, 1, 1].map((queued) => ({ label: "hobo", queued })),
				],
			},
		]);
		const result = await answer(
			'{"steps":[{"key":"fleet"}]}',
			{ fleet: "auto" },
			source,
		);
		expect(outputs(result).get("outcome")).toBe("waiting");
		expect(outputs(result).get("runner")).toBe("hobo");
	});
});

describe("R09: a hosted runner type that misses three jobs in thirty minutes", () => {
	const ORDER = '{"steps":[{"key":"depot"},{"key":"github"}]}';
	const INPUTS = { depot: "depot-ubuntu-24.04", github: "ubuntu-24.04" };
	const missed = (queued: readonly number[]): FakeRun => ({
		id: 10,
		created: 40,
		jobs: queued.map((minutes) => ({
			label: "depot-ubuntu-24.04",
			queued: minutes,
		})),
	});
	const key = providerHealthKey("depot", "depot-ubuntu-24.04");

	it("is skipped while its misses are in the same job list", async () => {
		const { source } = facts([missed([14, 13, 12])]);
		const read = await source.facts(testRouteRequest(REPO, OWN_RUN), NOW);
		expect([...read.unhealthy]).toEqual([key]);
		const result = await answer(ORDER, INPUTS, source);
		expect(outputs(result).get("runner")).toBe("ubuntu-24.04");
		expect(outputs(result).get("step")).toBe("github");
	});

	it("is not tripped by two misses, or by misses spread past thirty minutes", async () => {
		const two = facts([missed([14, 13])]);
		expect(
			(await two.source.facts(testRouteRequest(REPO, OWN_RUN), NOW)).unhealthy
				.size,
		).toBe(0);
		const spread = facts([missed([55, 35, 12])]);
		expect(
			(await spread.source.facts(testRouteRequest(REPO, OWN_RUN), NOW))
				.unhealthy.size,
		).toBe(0);
	});

	it("is not tripped by jobs held by a concurrency group", async () => {
		const run = missed([14, 13, 12]);
		const { source } = facts([
			{
				...run,
				jobs: run.jobs.map((job) => ({ ...job, status: "pending" })),
			},
		]);
		expect(
			(await source.facts(testRouteRequest(REPO, OWN_RUN), NOW)).unhealthy.size,
		).toBe(0);
	});

	it("is tried again once its back-off has passed", async () => {
		const { source } = facts([missed([30, 29, 28])]);
		const read = await source.facts(testRouteRequest(REPO, OWN_RUN), NOW);
		expect(read.unhealthy.size).toBe(0);
		const result = await answer(ORDER, INPUTS, source);
		expect(outputs(result).get("step")).toBe("depot");
	});

	it("is cleared by a job it started after the misses", async () => {
		const run = missed([16, 15, 14]);
		const { source } = facts([
			{
				...run,
				jobs: [
					...run.jobs,
					{ label: "depot-ubuntu-24.04", queued: 4, started: 3 },
				],
			},
		]);
		expect(
			(await source.facts(testRouteRequest(REPO, OWN_RUN), NOW)).unhealthy.size,
		).toBe(0);
	});
});

describe("reads stay inside their budget", () => {
	it("asks at most twelve times", async () => {
		const runs: FakeRun[] = Array.from({ length: 30 }, (_, index) => ({
			id: 100 + index,
			created: 30 - index,
			jobs: [{ label: "hobo", queued: 1 }],
		}));
		const { source, asked } = facts(runs, { slip: slipText("fleet-open") });
		await source.facts(testRouteRequest(REPO, OWN_RUN), NOW);
		expect(asked).toHaveLength(GITHUB_FACTS_MAX_CALLS);
		expect(asked.slice(0, 3)).toEqual([
			`/repos/${REPO}/git/ref/hobo/routing-slip`,
			`/repos/${REPO}/git/commits/${SLIP_SHA}`,
			`/repos/${REPO}/actions/runs?per_page=100`,
		]);
		expect(source.warnings).toEqual([]);
	});

	it("gives nothing measured and one titled warning when a read fails", async () => {
		const { source } = facts(
			[
				{
					id: 10,
					created: 6,
					jobs: [{ label: "hobo", queued: 6, started: 5 }],
				},
			],
			{ slip: slipText("fleet-open"), fail: "/jobs" },
		);
		const read = await source.facts(testRouteRequest(REPO, OWN_RUN), NOW);
		expect(read.fleet).toBeUndefined();
		expect(read.machines).toEqual([]);
		expect(read.unhealthy.size).toBe(0);
		expect(source.warnings).toHaveLength(1);
		expect(source.warnings[0]?.title).toBe(GITHUB_FACTS_WARNING_TITLE);
		expect(source.warnings[0]?.message).toContain("HTTP 502");
	});

	it("gives up when GitHub does not answer in time", async () => {
		const { source } = facts([], { hang: true }, 20);
		const read = await source.facts(testRouteRequest(REPO, OWN_RUN), NOW);
		expect(read.fleet).toBeUndefined();
		expect(source.warnings[0]?.message).toContain("in time");
	});

	it("ignores a slip it cannot use without warning", async () => {
		const { source } = facts([], { slip: "not a slip" });
		const read = await source.facts(testRouteRequest(REPO, OWN_RUN), NOW);
		expect(read.fleet?.enabled).toBe(false);
		expect(source.warnings).toEqual([]);
	});
});

describe("a recorded job list", () => {
	it("reads the held fleet probe as a fleet not taking jobs", async () => {
		const recorded = JSON.parse(
			readFileSync(
				new URL("./fixtures/relay-job/recorded-queue.json", import.meta.url),
				"utf8",
			),
		);
		const readAtMs = Date.parse(recorded.readAt);
		const repository = "hobo-labs/hobo";
		const fake = async (input: string | URL | Request): Promise<Response> => {
			const path = String(input).slice(API.length);
			if (path === `/repos/${repository}/actions/runs?per_page=100`)
				return new Response(JSON.stringify(recorded.runs));
			const match = /\/actions\/runs\/(\d+)\/jobs/u.exec(path);
			const page = match ? recorded.jobs[match[1] ?? ""] : undefined;
			return page
				? new Response(JSON.stringify(page))
				: new Response(JSON.stringify(match ? { jobs: [] } : {}), {
						status: match ? 200 : 404,
					});
		};
		const source = new GithubRouteFacts({
			token: "t",
			apiUrl: API,
			fetch: fake,
		});
		const read = await source.facts(
			testRouteRequest(repository, 43987800000),
			readAtMs,
		);
		expect(source.warnings).toEqual([]);
		expect(read.fleet).toEqual({
			enabled: false,
			taking: false,
			isolated: false,
		});
	});
});
