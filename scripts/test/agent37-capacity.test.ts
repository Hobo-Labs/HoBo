import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import {
	AGENT37_RUNNER_LABEL,
	type Agent37PoolState,
	agent37Capacity,
	selectFleetBackend,
} from "../../packages/ci/src/fleet-overflow.ts";
import {
	agent37Pool,
	type JsonValue,
	main,
	routeRunner,
} from "../ci/route-runner.mts";
import {
	type RunnerRouting,
	readRunnerRouting,
} from "../ci/runner-routing.mts";

const COMMITTED = readFileSync(
	new URL("../../.hobo/ci.json", import.meta.url),
	"utf8",
);

const hasTcpListenPort = (
	bound: NonNullable<ReturnType<Server["address"]>>,
): bound is AddressInfo => Object.prototype.hasOwnProperty.call(bound, "port");

const tcpListenPort = (server: Server): number => {
	const bound = server.address();
	if (bound === null || !hasTcpListenPort(bound)) {
		throw new Error("server not bound");
	}
	return bound.port;
};
const committedRouting: RunnerRouting | undefined =
	readRunnerRouting(COMMITTED);

const specAdmissiblePool: Agent37PoolState = {
	healthy: true,
	activeBoxes: 1,
	budgetRemainingMicros: 2_000_000,
	jobsInBatch: 2,
	reserveMicros: 1_000_000,
};
const plan = { maxBoxes: 4 };

describe("the agent37 capacity inequality (spec §5.4)", () => {
	it("admits a healthy pool whose budget and boxes both still hold the batch", () => {
		assert.deepEqual(agent37Capacity(specAdmissiblePool, plan), { ok: true });
	});

	it("admits the boundaries: budget exactly the reserve, boxes exactly the jobs", () => {
		assert.deepEqual(
			agent37Capacity(
				{
					...specAdmissiblePool,
					budgetRemainingMicros: specAdmissiblePool.reserveMicros,
					activeBoxes: plan.maxBoxes - specAdmissiblePool.jobsInBatch,
				},
				plan,
			),
			{ ok: true },
		);
	});

	it("refuses an unhealthy pool", () => {
		assert.deepEqual(
			agent37Capacity({ ...specAdmissiblePool, healthy: false }, plan),
			{
				ok: false,
				why: "unhealthy",
			},
		);
	});

	it("refuses a pool whose remaining budget cannot hold the reserve", () => {
		assert.deepEqual(
			agent37Capacity(
				{
					...specAdmissiblePool,
					budgetRemainingMicros: specAdmissiblePool.reserveMicros - 1,
				},
				plan,
			),
			{ ok: false, why: "over-budget" },
		);
		assert.deepEqual(
			agent37Capacity(
				{ ...specAdmissiblePool, budgetRemainingMicros: 0, reserveMicros: 0 },
				plan,
			),
			{ ok: true },
		);
	});

	it("refuses a pool with fewer free boxes than the batch has jobs", () => {
		assert.deepEqual(
			agent37Capacity(
				{
					...specAdmissiblePool,
					activeBoxes: plan.maxBoxes - specAdmissiblePool.jobsInBatch + 1,
				},
				plan,
			),
			{ ok: false, why: "no-boxes" },
		);
	});

	it("refuses an unobserved or malformed pool state rather than pass it", () => {
		assert.deepEqual(agent37Capacity(undefined, plan), {
			ok: false,
			why: "unobserved",
		});
		for (const malformed of [
			{ ...specAdmissiblePool, activeBoxes: -1 },
			{ ...specAdmissiblePool, activeBoxes: plan.maxBoxes + 1 },
		] satisfies ReadonlyArray<Agent37PoolState>)
			assert.deepEqual(agent37Capacity(malformed, plan), {
				ok: false,
				why: "unobserved",
			});
		assert.deepEqual(
			agent37Capacity(
				{ ...specAdmissiblePool, activeBoxes: 0 },
				{ maxBoxes: 0 },
			),
			{ ok: false, why: "no-boxes" },
		);
	});
});

describe("the committed agent37 overflow pool", () => {
	it("is the external pool entry carrying the agent37 runner label", () => {
		assert.deepEqual(agent37Pool(committedRouting), {
			label: AGENT37_RUNNER_LABEL,
			maxBoxes: 4,
		});
	});

	it("is nothing without an entry, a positive cap, or a policy at all", () => {
		const withPools = (pools: RunnerRouting["externalPools"]) =>
			agent37Pool(
				committedRouting
					? { ...committedRouting, externalPools: pools }
					: undefined,
			);
		assert.equal(withPools([]), undefined);
		assert.equal(
			withPools([
				{
					labels: ["other-pool"],
					runnerNamePrefix: "other-",
					maxRunners: 4,
				},
			]),
			undefined,
		);
		assert.equal(
			withPools([
				{
					labels: [AGENT37_RUNNER_LABEL],
					runnerNamePrefix: "hobo-a37-",
					maxRunners: 0,
				},
			]),
			undefined,
		);
		assert.equal(agent37Pool(undefined), undefined);
	});

	it("keeps the provider enabled with the other overflow providers off", () => {
		const project = JSON.parse(COMMITTED);
		const providers =
			project.environments.ci?.policy.providers.map(
				(provider: { id: string; enabled?: boolean }) => [
					provider.id,
					provider.enabled ?? false,
				],
			) ?? [];
		assert.deepEqual(providers, [
			["vercel-sandbox", false],
			["oracle-free-isolated", false],
			["github-hosted", false],
			["hostinger-arc", false],
			["agent37-runners", true],
		]);
	});
});

const fleetQueueLooksUp = {
	queued: 0,
	oldestWaitSeconds: 0,
	recentPickups: 1,
	slowestRecentPickupSeconds: 0,
};
const fleetQueueLooksIdle = { ...fleetQueueLooksUp, recentPickups: 0 };
const refusing = {
	queued: 4,
	oldestWaitSeconds: 900,
	recentPickups: 1,
	slowestRecentPickupSeconds: 0,
};
const limits = { maxWaitSeconds: 120, maxQueued: 4 };

describe("the queue rule's overflow order", () => {
	it("spills to agent37 when the fleet and local box have no room", () => {
		const routed = routeRunner({
			mode: "auto",
			fleetLabel: "hobo",
			localEnrolled: true,
			agent37: { label: AGENT37_RUNNER_LABEL, load: fleetQueueLooksUp },
			limits,
			fleet: refusing,
			local: refusing,
			undecidedAhead: 0,
		});
		assert.deepEqual(
			[routed.tier, routed.runner],
			["agent37", AGENT37_RUNNER_LABEL],
		);
		assert.match(routed.reason, /the agent37 pool has nothing waiting/);
	});

	it("keeps a taking fleet and an enrolled local box ahead of agent37", () => {
		const fleetFirst = routeRunner({
			mode: "auto",
			fleetLabel: "hobo",
			localEnrolled: true,
			agent37: { label: AGENT37_RUNNER_LABEL, load: fleetQueueLooksUp },
			limits,
			fleet: fleetQueueLooksUp,
			local: fleetQueueLooksUp,
			undecidedAhead: 0,
		});
		assert.deepEqual([fleetFirst.tier, fleetFirst.runner], ["fleet", "hobo"]);
		const localFirst = routeRunner({
			mode: "auto",
			fleetLabel: "hobo",
			localEnrolled: true,
			agent37: { label: AGENT37_RUNNER_LABEL, load: fleetQueueLooksUp },
			limits,
			fleet: refusing,
			local: fleetQueueLooksUp,
			undecidedAhead: 0,
		});
		assert.deepEqual(
			[localFirst.tier, localFirst.runner],
			["local", "hobo-local-host"],
		);
	});

	it("passes over an agent37 pool nothing has been seen to pick up", () => {
		const routed = routeRunner({
			mode: "auto",
			fleetLabel: "hobo",
			localEnrolled: false,
			agent37: { label: AGENT37_RUNNER_LABEL, load: fleetQueueLooksIdle },
			limits,
			fleet: refusing,
			local: fleetQueueLooksIdle,
			undecidedAhead: 0,
		});
		assert.deepEqual([routed.tier, routed.runner], ["github", "ubuntu-24.04"]);
	});

	it("selects agent37 before github in the shared overflow order", () => {
		const member = (backend: "local" | "agent37" | "github", free: number) => ({
			id: backend,
			backend,
			enabled: true,
			runsOn: backend,
			freeSlots: free,
		});
		assert.deepEqual(
			selectFleetBackend({
				members: [
					{
						id: "fleet",
						backend: "hobo",
						enabled: true,
						runsOn: "hobo",
						freeSlots: 0,
					},
					member("agent37", 1),
					member("github", 1),
				],
				currentLabels: [],
			}),
			{
				backend: "agent37",
				runsOn: "agent37",
				memberId: "agent37",
				spilled: true,
			},
		);
	});
});

const env = {
	GITHUB_WORKSPACE: new URL("../..", import.meta.url).pathname,
	GITHUB_EVENT_NAME: "pull_request",
	GITHUB_WORKFLOW_REF:
		"Hobo-Labs/HoBo/.github/workflows/hobo-ci.yml@refs/pull/1/merge",
	GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
	GITHUB_REPOSITORY_ID: "1274791462",
	GITHUB_REPOSITORY_OWNER_ID: "344805935",
	GITHUB_RUN_ID: "73",
	GITHUB_RUN_ATTEMPT: "2",
	GITHUB_SHA: "a".repeat(40),
	GITHUB_TOKEN: "token",
};
const publicRepo = {
	id: 1274791462,
	owner: { id: 344805935 },
	private: false,
	visibility: "public",
	disabled: false,
	archived: false,
};
const readPublic: typeof fetch = async () => Response.json(publicRepo);
const observedHealthyPool: Agent37PoolState = {
	healthy: true,
	activeBoxes: 0,
	budgetRemainingMicros: 2_000_000,
	jobsInBatch: 2,
	reserveMicros: 500_000,
};
const ciProjectWithExternalPools = (pools: RunnerRouting["externalPools"]) => {
	const routing = readRunnerRouting(COMMITTED);
	assert.ok(routing);
	const project = JSON.parse(COMMITTED);
	project.runnerRouting = { ...routing, externalPools: pools };
	return JSON.stringify(project);
};
const NO_POOLS = ciProjectWithExternalPools([]);

describe("the PR batch's agent37 overflow", () => {
	it("routes the batch to agent37 when the fleet claim fails and the pool holds", async () => {
		let asked = 0;
		const decision = await main([], env, {
			routingConfig: COMMITTED,
			fetch: readPublic,
			verifyPrBatchCapacity: async () => false,
			observeAgent37Pool: async () => {
				asked += 1;
				return observedHealthyPool;
			},
		});
		assert.equal(asked, 1);
		assert.deepEqual(
			[decision.tier, decision.runner, decision.refusedBy],
			["agent37", AGENT37_RUNNER_LABEL, "none"],
		);
		assert.match(decision.reason, /overflow pool is healthy/u);
	});

	it("keeps a verified fleet claim, without asking the pool", async () => {
		let asked = 0;
		const decision = await main([], env, {
			routingConfig: COMMITTED,
			fetch: async () => {
				throw new Error("unexpected read");
			},
			verifyPrBatchCapacity: async () => true,
			observeAgent37Pool: async () => {
				asked += 1;
				return observedHealthyPool;
			},
		});
		assert.equal(asked, 0);
		assert.deepEqual([decision.tier, decision.runner], ["fleet", "hobo"]);
	});

	it("falls back to GitHub-hosted when the pool is unhealthy", async () => {
		for (const state of [
			{ ...observedHealthyPool, healthy: false },
			{
				...observedHealthyPool,
				budgetRemainingMicros: 1,
				reserveMicros: 500_000,
			},
			{ ...observedHealthyPool, activeBoxes: 4, jobsInBatch: 2 },
			undefined,
		]) {
			const decision = await main([], env, {
				routingConfig: COMMITTED,
				fetch: readPublic,
				verifyPrBatchCapacity: async () => false,
				observeAgent37Pool: async () => state,
			});
			assert.deepEqual(
				[decision.tier, decision.runner],
				["github", "ubuntu-24.04"],
			);
		}
	});

	it("says why the pool could not take the batch", async () => {
		const decision = await main([], env, {
			routingConfig: COMMITTED,
			fetch: readPublic,
			verifyPrBatchCapacity: async () => false,
			observeAgent37Pool: async () => ({
				...observedHealthyPool,
				budgetRemainingMicros: 10,
			}),
		});
		assert.match(decision.reason, /over-budget/u);
		const unobserved = await main([], env, {
			routingConfig: COMMITTED,
			fetch: readPublic,
			verifyPrBatchCapacity: async () => false,
		});
		assert.match(unobserved.reason, /unobserved/u);
	});

	it("never asks the pool when the committed policy names none, or it throws", async () => {
		let asked = 0;
		const decision = await main([], env, {
			routingConfig: NO_POOLS,
			fetch: readPublic,
			verifyPrBatchCapacity: async () => false,
			observeAgent37Pool: async () => {
				asked += 1;
				return observedHealthyPool;
			},
		});
		assert.deepEqual(
			[decision.tier, decision.runner],
			["github", "ubuntu-24.04"],
		);
		assert.doesNotMatch(decision.reason, /agent37/u);
		const threw = await main([], env, {
			routingConfig: COMMITTED,
			fetch: readPublic,
			verifyPrBatchCapacity: async () => false,
			observeAgent37Pool: async () => {
				throw new Error("unavailable");
			},
		});
		assert.deepEqual([threw.tier, threw.runner], ["github", "ubuntu-24.04"]);
		assert.match(threw.reason, /unobserved/u);
		assert.equal(asked, 0);
	});

	it("does not use a pool answer returned after the routing decision expires", async () => {
		let clock = 1_000;
		const decision = await main([], env, {
			routingConfig: COMMITTED,
			fetch: readPublic,
			now: () => clock,
			verifyPrBatchCapacity: async () => false,
			observeAgent37Pool: async (scope) => {
				clock = scope.decisionDeadlineMs;
				return observedHealthyPool;
			},
		});
		assert.deepEqual(
			[decision.tier, decision.runner],
			["github", "ubuntu-24.04"],
		);
	});
});

describe("the merge-group main gate stays off agent37", () => {
	const mergeEnv = {
		...env,
		GITHUB_EVENT_NAME: "merge_group",
		GITHUB_WORKFLOW_REF:
			"Hobo-Labs/HoBo/.github/workflows/hobo-ci.yml@refs/heads/main",
	};

	it("keeps the batch on GitHub-hosted while the pool is configured and healthy", async () => {
		let asked = 0;
		const decision = await main([], mergeEnv, {
			routingConfig: COMMITTED,
			fetch: readPublic,
			observeAgent37Pool: async () => {
				asked += 1;
				return observedHealthyPool;
			},
		});
		assert.equal(asked, 0);
		assert.deepEqual(
			[decision.tier, decision.runner],
			["github", "ubuntu-24.04"],
		);
		assert.match(
			decision.reason,
			/agent37 overflow pool is not a merge-group main-gate runner/u,
		);
	});

	it("does not mention a pool the committed policy does not name", async () => {
		const decision = await main([], mergeEnv, {
			routingConfig: NO_POOLS,
			fetch: readPublic,
		});
		assert.doesNotMatch(decision.reason, /agent37/u);
	});
});

const runAgainstLocalGithubApi = async <T>(
	answer: (path: string) => JsonValue,
	run: (apiUrl: string) => Promise<T>,
) => {
	const server = createServer((request, response) => {
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify(answer(request.url ?? "")));
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const port = tcpListenPort(server);
	try {
		return await run(`http://127.0.0.1:${port}`);
	} finally {
		await new Promise((done) => server.close(done));
	}
};

describe("the queue rule through the script", () => {
	const PROBE_PATH = ".github/workflows/fleet-probe.yml";
	const NOW = Date.parse("2026-11-13T16:00:00Z");
	const at = (secondsAgo: number) =>
		new Date(NOW - secondsAgo * 1000).toISOString();
	const pages =
		(jobs: JsonValue[]) =>
		(path: string): JsonValue =>
			path.includes("/jobs")
				? { jobs }
				: {
						workflow_runs: [
							{
								id: 40,
								path: PROBE_PATH,
								status: "completed",
								created_at: at(70),
								updated_at: at(50),
							},
						],
					};
	const waiting = (label: string, seconds: number) => ({
		run_id: 40,
		status: "queued",
		labels: [label],
		created_at: at(seconds),
	});
	const pickup = (label: string) => ({
		run_id: 40,
		status: "completed",
		labels: [label],
		runner_name: "runner-1",
		created_at: at(65),
		started_at: at(60),
	});
	const nonBatchPullRequestEnv = {
		...env,
		GITHUB_WORKFLOW_REF:
			"Hobo-Labs/HoBo/.github/workflows/pricing-ci.yml@refs/pull/7/merge",
		GITHUB_RUN_ID: "51",
		GITHUB_EVENT_NAME: "pull_request",
	};

	it("routes a stalled fleet's pull request to the agent37 pool's pickups", async () => {
		await runAgainstLocalGithubApi(
			pages([waiting("hobo", 300), pickup(AGENT37_RUNNER_LABEL)]),
			async (apiUrl) => {
				const decision = await main(
					[],
					{ ...nonBatchPullRequestEnv, GITHUB_API_URL: apiUrl },
					{
						routingConfig: COMMITTED,
						fetch: async () =>
							Response.json({ message: "Not Found" }, { status: 404 }),
						now: () => NOW,
					},
				);
				assert.deepEqual(
					[decision.tier, decision.runner, decision.refusedBy],
					["agent37", AGENT37_RUNNER_LABEL, "queue"],
				);
			},
		);
	});

	it("never routes a trunk-class run to agent37, however healthy the pool looks", async () => {
		await runAgainstLocalGithubApi(
			pages([waiting("hobo-trunk", 300), pickup(AGENT37_RUNNER_LABEL)]),
			async (apiUrl) => {
				const decision = await main(
					[],
					{
						...nonBatchPullRequestEnv,
						GITHUB_EVENT_NAME: "push",
						GITHUB_API_URL: apiUrl,
					},
					{
						routingConfig: COMMITTED,
						fetch: async () =>
							Response.json({ message: "Not Found" }, { status: 404 }),
						now: () => NOW,
					},
				);
				assert.deepEqual(
					[decision.tier, decision.runner, decision.refusedBy],
					["github", "ubuntu-24.04", "queue"],
				);
			},
		);
	});
});
