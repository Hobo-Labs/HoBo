import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type Agent37PoolObservation,
	type Agent37PoolPolicy,
	agent37Capacity,
	type FleetMember,
	selectFleetBackend,
	selectFleetVerification,
} from "../../packages/ci/src/fleet-overflow.ts";
import {
	type FleetOverflowMember,
	planFleetVerification,
	readFleetOverflowPolicy,
} from "../ci/fleet-signoff.mts";
import {
	type Agent37PoolObserver,
	fleetLabelFor,
	main,
	type RouteDecision,
	routeSettings,
} from "../ci/route-runner.mts";
import { readRunnerRouting } from "../ci/runner-routing.mts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const committedText = readFileSync(join(root, ".hobo/ci.json"), "utf8");
const committedRouting = readRunnerRouting(committedText);
const committedPool = committedRouting?.externalPools[0];
const idle: Agent37PoolObservation = { activeRunners: 0 };
const pool = (overrides: Partial<FleetMember> = {}): FleetMember => ({
	id: "ci:agent37-runners",
	backend: "agent37",
	enabled: true,
	runsOn: "hobo-agent37",
	freeSlots: 1,
	...overrides,
});

describe("agent37 pool capacity, pure", () => {
	it("subtracts what an observation says the pool holds from the committed ceiling", () => {
		assert.deepEqual(
			agent37Capacity(
				{
					labels: ["hobo-agent37"],
					runnerNamePrefix: "hobo-a37-",
					maxRunners: 4,
				},
				{ activeRunners: 1 },
			),
			{ runsOn: "hobo-agent37", runnerNamePrefix: "hobo-a37-", freeRunners: 3 },
		);
		assert.deepEqual(
			agent37Capacity(
				{
					labels: ["hobo-agent37"],
					runnerNamePrefix: "hobo-a37-",
					maxRunners: 4,
				},
				{ activeRunners: 4 },
			),
			undefined,
		);
	});

	it("spills to the pool's first declared label", () => {
		const capacity = agent37Capacity(
			{
				labels: ["hobo-agent37", "hobo-agent37-fast"],
				runnerNamePrefix: "hobo-a37-",
				maxRunners: 2,
			},
			idle,
		);
		assert.equal(capacity?.runsOn, "hobo-agent37");
	});

	it("refuses an off, over-ceiling or malformed pool", () => {
		const good = {
			labels: ["hobo-agent37"],
			runnerNamePrefix: "hobo-a37-",
			maxRunners: 4,
		};
		for (const malformed of [
			{ ...good, maxRunners: 0 },
			{ ...good, maxRunners: 10_001 },
			{ ...good, maxRunners: 1.5 },
			{ ...good, maxRunners: Number.NaN },
			{ ...good, labels: [] },
			{ ...good, labels: [""] },
			{ ...good, labels: [" "] },
			{ ...good, runnerNamePrefix: "" },
			{ ...good, runnerNamePrefix: "x".repeat(129) },
			{ ...good, labels: ["hobo-agent37", ""] },
		])
			assert.equal(agent37Capacity(malformed, idle), undefined);
		assert.equal(
			agent37Capacity({ ...good, maxRunners: 10_000 }, { activeRunners: 9_999 })
				?.freeRunners,
			1,
		);
	});

	it("refuses a malformed or hostile observation rather than guessing capacity", () => {
		const good = {
			labels: ["hobo-agent37"],
			runnerNamePrefix: "hobo-a37-",
			maxRunners: 4,
		};
		for (const observation of [
			{ activeRunners: -1 },
			{ activeRunners: 1.5 },
			{ activeRunners: Number.NaN },
			{ activeRunners: Number.POSITIVE_INFINITY },
			JSON.parse("{}"),
		])
			assert.equal(agent37Capacity(good, observation), undefined);
		assert.equal(agent37Capacity(good, { activeRunners: 5 }), undefined);
	});

	it("reads the committed pool and its ceiling matches the provider's own box ceiling", () => {
		assert.ok(committedRouting);
		assert.ok(committedPool);
		assert.deepEqual(committedPool, {
			labels: ["hobo-agent37"],
			runnerNamePrefix: "hobo-a37-",
			maxRunners: 4,
		});
		const project = JSON.parse(committedText);
		const provider = project.environments.ci.policy.providers.find(
			(entry: { id: string }) => entry.id === "agent37-runners",
		);
		assert.equal(provider.enabled, true);
		assert.equal(provider.pool.maxBoxes, committedPool.maxRunners);
		assert.deepEqual(agent37Capacity(committedPool, { activeRunners: 2 }), {
			runsOn: "hobo-agent37",
			runnerNamePrefix: "hobo-a37-",
			freeRunners: 2,
		});
	});
});

describe("the agent37 fleet overflow backend", () => {
	it("spills to arc and a local box before the rented pool, and to it before hosted", () => {
		const arc: FleetMember = {
			id: "ci:arc",
			backend: "arc",
			enabled: true,
			runsOn: "hobo-arc",
			freeSlots: 1,
		};
		const local: FleetMember = {
			id: "local",
			backend: "local",
			enabled: true,
			runsOn: "hobo-local-host",
			freeSlots: 1,
		};
		const github: FleetMember = {
			id: "github",
			backend: "github",
			enabled: true,
			runsOn: "ubuntu-24.04",
			freeSlots: 1,
		};
		const choose = (candidates: readonly FleetMember[]) =>
			selectFleetBackend({ members: candidates, currentLabels: [] });
		assert.deepEqual(choose([pool(), arc, local, github])?.backend, "arc");
		assert.deepEqual(choose([pool(), local, github])?.backend, "local");
		assert.deepEqual(choose([pool(), github])?.backend, "agent37");
		assert.deepEqual(choose([github])?.backend, "github");
	});

	it("keeps a job already bound to the pool's label on it, never re-relayed to hobo", () => {
		const selection = selectFleetBackend({
			members: [
				{
					id: "fleet",
					backend: "hobo",
					enabled: true,
					runsOn: "hobo",
					freeSlots: 1,
				},
				pool({ freeSlots: 0 }),
			],
			currentLabels: ["hobo-agent37"],
		});
		assert.deepEqual(
			selection?.backend === "agent37" && selection.spilled,
			true,
		);
	});

	it("offers a healthy agent37 member for verification before hosted compute", () => {
		const choice = selectFleetVerification({
			members: [
				{
					id: "fleet",
					backend: "hobo",
					enabled: true,
					runsOn: "hobo",
					freeSlots: 0,
				},
				pool(),
				{
					id: "github",
					backend: "github",
					enabled: true,
					runsOn: "ubuntu-24.04",
					freeSlots: 1,
				},
			],
			unknownMembers: [],
			localSignoffEnabled: false,
		});
		assert.equal(choice.kind, "runner");
		assert.deepEqual(
			choice.kind === "runner" && [choice.runner.backend, choice.runner.runsOn],
			["agent37", "hobo-agent37"],
		);
	});

	it("fails verification closed when an enabled agent37 member's capacity is unknown", () => {
		const choice = selectFleetVerification({
			members: [
				{
					id: "fleet",
					backend: "hobo",
					enabled: true,
					runsOn: "hobo",
					freeSlots: 0,
				},
				pool(),
				{
					id: "github",
					backend: "github",
					enabled: true,
					runsOn: "ubuntu-24.04",
					freeSlots: 0,
				},
			],
			unknownMembers: ["ci:agent37-runners"],
			localSignoffEnabled: true,
		});
		assert.deepEqual(choice, { kind: "wait", reason: "availability-unknown" });
	});
});

describe("the PR batch spill to agent37", () => {
	const env = {
		GITHUB_WORKSPACE: root,
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
	const refusesEverything: typeof fetch = async () => {
		throw new Error("public compute evidence must not be read");
	};
	const observerOf = (
		observation: Agent37PoolObservation,
		seen: Agent37PoolPolicy[] = [],
	): Agent37PoolObserver => {
		const observer: Agent37PoolObserver = async (candidate) => {
			seen.push(candidate);
			return observation;
		};
		return observer;
	};

	it("takes the batch on the committed pool when the fleet claim fails", async () => {
		const observed: Parameters<Agent37PoolObserver>[0][] = [];
		const decision = await main([], env, {
			routingConfig: committedText,
			fetch: refusesEverything,
			verifyPrBatchCapacity: async () => false,
			observeAgent37Pool: observerOf({ activeRunners: 1 }, observed),
		});
		assert.deepEqual(
			[decision.tier, decision.runner, decision.refusedBy],
			["agent37", "hobo-agent37", "none"],
		);
		assert.equal(decision.slip?.kind, "unasked");
		assert.match(
			decision.reason,
			/no verified fleet capacity and Broker claim; the agent37 external pool hobo-agent37 reports 3 free runner\(s\)/u,
		);
		assert.deepEqual(observed, [
			{
				labels: ["hobo-agent37"],
				runnerNamePrefix: "hobo-a37-",
				maxRunners: 4,
			},
		]);
	});

	it("spills without any verifier installed, and writes runner, tier and shard outputs", async () => {
		const dir = mkdtempSync(join(tmpdir(), "agent37-spill-"));
		try {
			const output = join(dir, "output");
			writeFileSync(output, "");
			const decision = await main(
				[],
				{ ...env, GITHUB_OUTPUT: output },
				{
					routingConfig: committedText,
					fetch: refusesEverything,
					observeAgent37Pool: observerOf(idle),
				},
			);
			assert.equal(decision.runner, "hobo-agent37");
			assert.equal(
				readFileSync(output, "utf8"),
				"box_runner=\nrunner=hobo-agent37\ntier=agent37\nshard_runner=hobo-agent37\n",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps a verified fleet claim on the fleet without consulting the pool", async () => {
		const decision = await main([], env, {
			routingConfig: committedText,
			fetch: refusesEverything,
			verifyPrBatchCapacity: async () => true,
			observeAgent37Pool: async () => {
				throw new Error("the pool must not be observed");
			},
		});
		assert.deepEqual([decision.tier, decision.runner], ["fleet", "hobo"]);
	});

	it("falls back to verified public compute when no observer is installed", async () => {
		const decision = await main([], env, {
			routingConfig: committedText,
			fetch: readPublic,
			verifyPrBatchCapacity: async () => false,
		});
		assert.deepEqual(
			[decision.tier, decision.runner],
			["github", "ubuntu-24.04"],
		);
	});

	it("falls back when the observer fails, answers garbage, or reports the pool saturated", async () => {
		const observers: readonly Agent37PoolObserver[] = [
			async () => {
				throw new Error("pool observation unavailable");
			},
			async () => JSON.parse('{"activeRunners": 4}'),
			async () => JSON.parse('{"activeRunners": -1}'),
			async () => JSON.parse("{}"),
		];
		for (const observer of observers) {
			const decision = await main([], env, {
				routingConfig: committedText,
				fetch: readPublic,
				verifyPrBatchCapacity: async () => false,
				observeAgent37Pool: observer,
			});
			assert.deepEqual(
				[decision.tier, decision.runner],
				["github", "ubuntu-24.04"],
			);
		}
	});

	it("still spills when a fleet answer arrives after the decision expires", async () => {
		let clock = 1_000;
		const decision = await main([], env, {
			routingConfig: committedText,
			fetch: refusesEverything,
			now: () => clock,
			verifyPrBatchCapacity: async (scope) => {
				clock = scope.decisionDeadlineMs;
				return true;
			},
			observeAgent37Pool: observerOf(idle),
		});
		assert.deepEqual(
			[decision.tier, decision.runner],
			["agent37", "hobo-agent37"],
		);
	});

	it("never sends the merge-group batch to the pool", async () => {
		const decision = await main(
			[],
			{ ...env, GITHUB_EVENT_NAME: "merge_group" },
			{
				routingConfig: committedText,
				fetch: readPublic,
				observeAgent37Pool: async () => {
					throw new Error("the pool must not be observed");
				},
			},
		);
		assert.deepEqual(
			[decision.tier, decision.runner],
			["github", "ubuntu-24.04"],
		);
	});

	it("keeps an explicit pin and never observes the pool for it", async () => {
		const decision = await main(["--route", "fleet"], env, {
			routingConfig: committedText,
			fetch: refusesEverything,
			observeAgent37Pool: async () => {
				throw new Error("the pool must not be observed");
			},
		});
		assert.deepEqual([decision.tier, decision.runner], ["fleet", "hobo"]);
	});

	it("leaves trunk events on the queue rule, which weighs no external pool", async () => {
		const lines: string[] = [];
		const log = console.log;
		console.log = (...parts: unknown[]) => {
			lines.push(parts.map(String).join(" "));
		};
		let observed = 0;
		try {
			const decision = await main(
				[],
				{
					...env,
					GITHUB_EVENT_NAME: "push",
					GITHUB_API_URL: "http://127.0.0.1:9",
				},
				{
					routingConfig: committedText,
					fetch: async () => new Response(null, { status: 404 }),
					observeAgent37Pool: async () => {
						observed += 1;
						return idle;
					},
				},
			);
			assert.deepEqual(
				[decision.tier, decision.runner, fleetLabelFor("push")],
				["github", "ubuntu-24.04", "hobo-trunk"],
			);
		} finally {
			console.log = log;
		}
		assert.equal(observed, 0);
		assert.ok(lines.some((line) => line.includes("hobo-ci-route-fallback")));
	});

	it("does not re-ask the batch path when the run asks again with its own jobs", async () => {
		let observed = 0;
		const decision = await main(
			["--include-own-run", "true"],
			{
				...env,
				GITHUB_API_URL: "http://127.0.0.1:9",
			},
			{
				routingConfig: committedText,
				fetch: async () => new Response(null, { status: 404 }),
				observeAgent37Pool: async () => {
					observed += 1;
					return idle;
				},
			},
		);
		assert.notEqual(decision.tier, "agent37");
		assert.equal(observed, 0);
	});

	it("routes by a policy with no pools exactly as before the feature", async () => {
		const project = JSON.parse(committedText);
		project.runnerRouting.externalPools = [];
		const decision = await main([], env, {
			routingConfig: JSON.stringify(project),
			fetch: readPublic,
			verifyPrBatchCapacity: async () => false,
			observeAgent37Pool: observerOf(idle),
		});
		assert.deepEqual(
			[decision.tier, decision.runner],
			["github", "ubuntu-24.04"],
		);
	});

	it("spills only through committed external pools, in committed order", async () => {
		const project = JSON.parse(committedText);
		project.runnerRouting.externalPools = [
			{
				labels: ["hobo-agent37"],
				runnerNamePrefix: "hobo-a37-",
				maxRunners: 0,
			},
			{
				labels: ["hobo-agent37-fast"],
				runnerNamePrefix: "hobo-a37-fast-",
				maxRunners: 2,
			},
		];
		const decision = await main([], env, {
			routingConfig: JSON.stringify(project),
			fetch: refusesEverything,
			verifyPrBatchCapacity: async () => false,
			observeAgent37Pool: observerOf({ activeRunners: 1 }),
		});
		assert.deepEqual(
			[decision.tier, decision.runner],
			["agent37", "hobo-agent37-fast"],
		);
		assert.match(decision.reason, /reports 1 free runner\(s\)/u);
	});
});

describe("the signoff inventory over the agent37 provider", () => {
	it("reads the committed policy and inventories the enabled provider and its pool", () => {
		assert.deepEqual(readFleetOverflowPolicy(committedText), [
			{
				id: "ci:agent37-runners",
				runsOn: "hobo-agent37",
				observable: true,
				backend: "agent37",
			},
			{
				id: "external-pool:0:hobo-agent37",
				runsOn: "hobo-agent37",
				observable: true,
			},
		]);
	});

	it("refuses a malformed agent37 pool declaration, and skips a disabled one", () => {
		const source = JSON.parse(committedText);
		const provider = source.environments.ci.policy.providers.find(
			(entry: { id: string }) => entry.id === "agent37-runners",
		);
		for (const malformed of [42, [], "pool", null])
			for (const enabled of [true, false]) {
				provider.pool = malformed;
				provider.enabled = enabled;
				assert.equal(
					readFleetOverflowPolicy(JSON.stringify(source)),
					undefined,
				);
			}
		delete provider.pool;
		provider.enabled = false;
		assert.deepEqual(readFleetOverflowPolicy(JSON.stringify(source)), [
			{
				id: "external-pool:0:hobo-agent37",
				runsOn: "hobo-agent37",
				observable: true,
			},
		]);
		provider.enabled = true;
		assert.deepEqual(readFleetOverflowPolicy(JSON.stringify(source)), [
			{
				id: "ci:agent37-runners",
				runsOn: "hobo-agent37",
				observable: true,
				backend: "agent37",
			},
			{
				id: "external-pool:0:hobo-agent37",
				runsOn: "hobo-agent37",
				observable: true,
			},
		]);
	});

	it("refuses an agent37 provider with undocumented keys", () => {
		const source = JSON.parse(committedText);
		const provider = source.environments.ci.policy.providers.find(
			(entry: { id: string }) => entry.id === "agent37-runners",
		);
		provider.engine = { name: "surprise" };
		assert.equal(readFleetOverflowPolicy(JSON.stringify(source)), undefined);
		delete provider.engine;
		provider.unknown = true;
		assert.equal(readFleetOverflowPolicy(JSON.stringify(source)), undefined);
	});
});

describe("the signoff plan over an agent37 member", () => {
	const now = Date.parse("2026-11-16T18:00:00Z");
	const settings = { ...routeSettings(undefined), localRunner: true };
	const member: FleetOverflowMember = {
		id: "ci:agent37-runners",
		runsOn: "hobo-agent37",
		observable: true,
		backend: "agent37",
	};
	const seenJob = (
		job: { labels: string[]; started: boolean },
		index: number,
	) => {
		const base = {
			runId: index + 1,
			labels: job.labels,
			createdAtMs: job.started ? now - 10_000 : now - 500_000,
		};
		return job.started ? { ...base, startedAtMs: now - 8_000 } : base;
	};
	const plan = (
		jobs: readonly { labels: string[]; started: boolean }[],
		options: {
			providerUnavailable?: readonly string[];
			githubUnavailable?: boolean;
		} = {},
	) =>
		planFleetVerification({
			settings,
			localSignoffEnabled: true,
			githubUnavailable: options.githubUnavailable ?? false,
			overflow: [member],
			providerUnavailable: options.providerUnavailable ?? [],
			readSlip: async () => ({ ok: false, why: "no routing slip" }),
			readQueue: async () => ({
				jobs: jobs.map(seenJob),
				undecidedAhead: 0,
				probeUnderway: false,
			}),
			nowMs: now,
		});

	it("verifies on a healthy agent37 member as overflow before hosted compute", async () => {
		const choice = await plan([
			{ labels: ["hobo"], started: false },
			{ labels: ["hobo-agent37"], started: true },
			{ labels: ["ubuntu-24.04"], started: true },
		]);
		assert.deepEqual(choice, {
			kind: "runner",
			tier: "overflow",
			runner: "hobo-agent37",
		});
	});

	it("waits while the pool's capacity is unknown, and signsoff locally only when it is asserted down", async () => {
		const unknown = await plan([{ labels: ["hobo"], started: false }]);
		assert.deepEqual(unknown, { kind: "wait", reason: "availability-unknown" });
		const signoff = await plan(
			[
				{ labels: ["hobo"], started: false },
				{ labels: ["hobo-local-host"], started: false },
			],
			{
				providerUnavailable: ["ci:agent37-runners"],
				githubUnavailable: true,
			},
		);
		assert.deepEqual(signoff, { kind: "local-signoff" });
	});
});

describe("the route notice records the spill", () => {
	it("carries the agent37 tier for a spilled batch", async () => {
		const env = {
			GITHUB_WORKSPACE: root,
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
		const lines: string[] = [];
		const log = console.log;
		console.log = (...parts: unknown[]) => {
			lines.push(parts.map(String).join(" "));
		};
		try {
			const decision: RouteDecision = await main([], env, {
				routingConfig: committedText,
				fetch: async () => {
					throw new Error("unexpected read");
				},
				observeAgent37Pool: async () => ({ activeRunners: 0 }),
			});
			assert.equal(decision.tier, "agent37");
			const notice = lines.find((line) =>
				line.startsWith("::notice title=hobo-ci-route::"),
			);
			assert.equal(
				notice,
				'::notice title=hobo-ci-route::{"v":2,"workflow":"hobo-ci.yml","tier":"agent37","runner":"hobo-agent37","slip":"unasked","why":"batch","refusedBy":"none"}',
			);
		} finally {
			console.log = log;
		}
	});
});
