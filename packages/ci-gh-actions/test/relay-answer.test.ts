/**
 * Relay mode end to end against the GitHub simulator (ADR-0183): a queued
 * relay job is answered by a HoBo node over the runner protocol, with no
 * runner process and no network. These are the T2 runs of gauntlet cases
 * R01, R04, R05, R06b, R13, R16 and X01; X03 is in
 * `relay-answer-safety.test.ts`.
 *
 * Built, not proven: the runner service here is the simulator's. No run
 * against GitHub's runner service is linked yet.
 */
import type { RunnerRouteEvent } from "@hobo/ci";
import { createMemoryMesh, createMeshCoordinator } from "@hobo/ci/mesh";
import {
	InMemoryMachineRegistry,
	InMemoryRouteJournal,
	testMachineAdvert,
} from "@hobo/ci/runner-order/testing";
import { describe, expect, it } from "vitest";
import type { GithubTransport } from "../src/github.js";
import {
	createRelayAnswerer,
	RELAY_CONFIG_PATH,
	RELAY_STALE_RUNNER_MS,
	type RelayAnswerer,
	type RelayAnswererOptions,
	type RelayTurn,
	relayRunnerRun,
	StoreRouteFacts,
	type StoreRouteFactsDeps,
} from "../src/relay-answer/index.js";
import { testJitConfig } from "../src/runner-protocol/port.js";
import {
	GithubSimulator,
	SIMULATED_ACTOR_ID,
	SimulatedRunnerService,
	simulatorTransport,
} from "./support/github-simulator/index.js";
import type { SimulatedJob } from "./support/github-simulator-port.js";

const REPO = "octo/app";
const ACCOUNT = "acct-1";
const CONNECTIONS = [{ installationId: 1, repository: REPO }];

type NodeSetup = Readonly<{
	node?: string;
	answer?: boolean;
	facts?: Partial<StoreRouteFactsDeps>;
	turn?: RelayTurn;
	transport?: GithubTransport;
}>;

type RelayNode = Readonly<{
	answerer: RelayAnswerer;
	journal: InMemoryRouteJournal;
	registry: InMemoryMachineRegistry;
}>;

function relayNode(sim: GithubSimulator, setup: NodeSetup = {}): RelayNode {
	const journal = new InMemoryRouteJournal();
	const registry = new InMemoryMachineRegistry();
	const options: RelayAnswererOptions = {
		relayJobs: { answer: setup.answer ?? true, label: "hobo-relay" },
		github: setup.transport ?? simulatorTransport(sim),
		runnerService: new SimulatedRunnerService(sim),
		// The simulator's configurations carry placeholder keys; the real parser
		// is tested on its own in runner-protocol-jit-config.test.ts.
		readJitConfig: (_encoded, runnerName) => testJitConfig(runnerName),
		account: async () => ACCOUNT,
		facts: (accountId) =>
			new StoreRouteFacts({
				accountId,
				fleet: undefined,
				machines: registry,
				readers: undefined,
				spend: undefined,
				health: undefined,
				minutes: undefined,
				onWarning: undefined,
				...setup.facts,
			}),
		journal,
		node: setup.node ?? "node-a",
		turn: setup.turn,
		webhookSecret: sim.webhookSecret,
		nowMs: () => sim.nowMs(),
	};
	return { answerer: createRelayAnswerer(options), journal, registry };
}

function turnOn(
	sim: GithubSimulator,
	steps: readonly string[] = ["github"],
	repository = REPO,
): void {
	sim.putFile(
		repository,
		RELAY_CONFIG_PATH,
		JSON.stringify({
			relayJobs: { answer: true },
			runnerOrder: { steps: steps.map((key) => ({ key })) },
		}),
	);
}

/** A queued relay job and the run it belongs to. */
type QueuedRelay = Readonly<{ relay: SimulatedJob; runId: number }>;

/** A relay job and the job behind it, which runs on the relay's `runner` output. */
function queueRelay(
	sim: GithubSimulator,
	inputs: ReadonlyMap<string, string> = new Map([["github", "ubuntu-24.04"]]),
	repository = REPO,
): QueuedRelay {
	const relay = sim.queueJob({
		repository,
		name: "route",
		labels: ["hobo-relay"],
		inputs,
	});
	sim.queueJob({
		repository,
		name: "build",
		runId: relay.runId,
		labels: ["${{ needs.route.outputs.runner }}"],
		needs: ["route"],
	});
	return { relay, runId: relay.runId };
}

function job(sim: GithubSimulator, name: string, runId: number): SimulatedJob {
	const found = sim
		.jobs()
		.find((entry) => entry.name === name && entry.runId === runId);
	if (!found) throw new Error(`no job ${name} in run ${runId}`);
	return found;
}

function decided(
	events: readonly RunnerRouteEvent[],
): readonly RunnerRouteEvent[] {
	return events.filter((event) => event.type === "runner.route.Decided");
}

async function decisions(
	node: RelayNode,
): Promise<readonly RunnerRouteEvent[]> {
	return decided(
		await node.journal.decisions({
			accountId: ACCOUNT,
			repository: undefined,
			sinceMs: 0,
			limit: 100,
		}),
	);
}

describe("relay mode (R01): a queued relay job is answered by the relay", () => {
	it("answers within five seconds of the queued webhook, on no runner, and the job behind it runs where it said", async () => {
		const sim = new GithubSimulator();
		turnOn(sim);
		const node = relayNode(sim);
		const { runId } = queueRelay(sim);
		const started = performance.now();
		const [response] = await sim.deliver(node.answerer.webhook);
		const elapsed = performance.now() - started;
		expect(await response?.json()).toEqual({
			outcome: "answered",
			reason: "",
			message: "",
		});
		const route = job(sim, "route", runId);
		expect(route).toMatchObject({ status: "completed", conclusion: "success" });
		expect(route.completedAtMs ?? 0).toBeLessThanOrEqual(
			route.queuedAtMs + 5_000,
		);
		expect(elapsed).toBeLessThan(5_000);
		expect(route.outputs.get("runner")).toBe("ubuntu-24.04");
		expect(route.outputs.get("step")).toBe("github");
		expect(route.outputs.get("outcome")).toBe("routed");
		// It ran on a one-job relay runner that is gone again: no runner process,
		// no billed minute, nothing left registered.
		expect(route.runnerName).toMatch(/^hobo-relay-\d+-\d+-1$/u);
		expect(sim.runners()).toEqual([]);
		expect(job(sim, "build", runId)).toMatchObject({
			status: "queued",
			labels: ["ubuntu-24.04"],
		});
		const journaled = await decisions(node);
		expect(journaled).toHaveLength(1);
		expect(journaled[0]).toMatchObject({ mode: "relay", node: "node-a" });
	});

	it("answers a redelivered webhook once", async () => {
		const sim = new GithubSimulator();
		turnOn(sim);
		const node = relayNode(sim);
		const { runId } = queueRelay(sim);
		await sim.deliver(node.answerer.webhook);
		const queuedHook = sim.deliveries()[0];
		if (!queuedHook) throw new Error("no delivery");
		sim.redeliver(queuedHook.id);
		const generated = () =>
			sim
				.requests()
				.filter((request) => request.path.endsWith("/generate-jitconfig"))
				.length;
		const before = generated();
		await sim.deliver(node.answerer.webhook);
		expect(generated()).toBe(before);
		expect(job(sim, "route", runId).conclusion).toBe("success");
		expect(await decisions(node)).toHaveLength(1);
	});

	it("refuses a webhook that is not signed with the relay's secret", async () => {
		const sim = new GithubSimulator();
		turnOn(sim);
		const node = relayNode(sim);
		const response = await node.answerer.webhook(
			new Request("https://relay.invalid/webhook", {
				method: "POST",
				headers: {
					"x-github-event": "workflow_job",
					"x-hub-signature-256": `sha256=${"0".repeat(64)}`,
				},
				body: "{}",
			}),
		);
		expect(response.status).toBe(401);
		expect(sim.requests()).toEqual([]);
	});
});

describe("relay mode is off unless turned on", () => {
	it("registers nothing and asks GitHub nothing with the node's flag off", async () => {
		const sim = new GithubSimulator();
		turnOn(sim);
		const node = relayNode(sim, { answer: false });
		const { runId } = queueRelay(sim);
		await sim.deliver(node.answerer.webhook);
		expect(await node.answerer.rescue(CONNECTIONS)).toMatchObject({
			queued: 0,
		});
		expect(await node.answerer.sweep(CONNECTIONS)).toMatchObject({
			deleted: [],
		});
		expect(sim.requests()).toEqual([]);
		expect(sim.runners()).toEqual([]);
		expect(job(sim, "route", runId).status).toBe("queued");
	});

	it("registers nothing for a repository whose .hobo/ci.json leaves it off", async () => {
		const sim = new GithubSimulator();
		sim.putFile(
			REPO,
			RELAY_CONFIG_PATH,
			'{"runnerOrder":{"steps":[{"key":"github"}]}}',
		);
		const node = relayNode(sim);
		const { relay } = queueRelay(sim);
		const outcome = await node.answerer.answer({
			installationId: 1,
			repository: REPO,
			jobId: relay.id,
			runId: relay.runId,
			runAttempt: 1,
			name: "route",
			labels: ["hobo-relay"],
			queuedAtMs: relay.queuedAtMs,
		});
		expect(outcome).toMatchObject({
			kind: "skipped",
			reason: "repository-off",
		});
		expect(
			sim.requests().map((request) => `${request.method} ${request.path}`),
		).toEqual([`GET /repos/${REPO}/contents/.hobo%2Fci.json`]);
		expect(sim.runners()).toEqual([]);
	});

	it("leaves a job alone that asks for more than the relay label", async () => {
		const sim = new GithubSimulator();
		turnOn(sim);
		const node = relayNode(sim);
		const other = sim.queueJob({
			repository: REPO,
			name: "build",
			labels: ["hobo-relay", "linux"],
		});
		await sim.deliver(node.answerer.webhook);
		expect(sim.requests()).toEqual([]);
		expect(sim.jobs().find((entry) => entry.id === other.id)?.status).toBe(
			"queued",
		);
	});
});

describe("relay mode decides with the relay's own facts", () => {
	it("R04: with nothing that fits, the relay job fails with the reason and the job behind it is skipped", async () => {
		const sim = new GithubSimulator();
		turnOn(sim, ["machine"]);
		const node = relayNode(sim);
		const { runId } = queueRelay(sim, new Map([["machine", "self-hosted"]]));
		await sim.deliver(node.answerer.webhook);
		const route = job(sim, "route", runId);
		expect(route.conclusion).toBe("failure");
		expect(route.outputs.get("outcome")).toBe("none");
		expect(route.annotations).toHaveLength(1);
		expect(route.annotations[0]).toBe(route.outputs.get("reason"));
		expect(route.annotations[0]).toMatch(/machine/u);
		expect(job(sim, "build", runId).conclusion).toBe("skipped");
	});

	it("R05: a busy machine is waited on, the job queues on its label, and cancelling frees it", async () => {
		const sim = new GithubSimulator();
		turnOn(sim, ["machine"]);
		const node = relayNode(sim);
		await node.registry.put(
			testMachineAdvert({
				id: "m-1",
				accountId: ACCOUNT,
				slots: 1,
				busy: 1,
				// The run's starter owns it, so a machine shared with only its owner admits the job.
				ownerId: SIMULATED_ACTOR_ID,
				lastSeenMs: sim.nowMs(),
			}),
		);
		const { runId } = queueRelay(sim, new Map([["machine", "self-hosted"]]));
		await sim.deliver(node.answerer.webhook);
		const route = job(sim, "route", runId);
		expect(route.conclusion).toBe("success");
		expect(route.outputs.get("outcome")).toBe("waiting");
		expect(route.outputs.get("runner")).toBe("hobo-machine-m-1");
		expect(job(sim, "build", runId)).toMatchObject({
			status: "queued",
			labels: ["hobo-machine-m-1"],
		});
		sim.cancelRun(runId);
		expect(job(sim, "build", runId)).toMatchObject({
			status: "completed",
			conclusion: "cancelled",
		});
	});

	it("R06b: the fleet takes a public repository's relay job only when it isolates such jobs", async () => {
		const sim = new GithubSimulator();
		sim.addRepository("octo/public", false);
		turnOn(sim, ["fleet", "github"], "octo/public");
		const leases = { activeLeases: async () => [] };
		const shared = relayNode(sim, {
			facts: { fleet: { slots: 4, isolated: false, leases } },
		});
		const inputs = new Map([
			["fleet", "hobo"],
			["github", "ubuntu-24.04"],
		]);
		const first = queueRelay(sim, inputs, "octo/public");
		await sim.deliver(shared.answerer.webhook);
		expect(job(sim, "route", first.runId).outputs.get("runner")).toBe(
			"ubuntu-24.04",
		);
		const [decision] = await decisions(shared);
		expect(
			decision?.decision?.skipped.map((skip) => [skip.key, skip.reason]),
		).toEqual([["fleet", "needs_isolation"]]);

		const isolated = relayNode(sim, {
			node: "node-b",
			facts: { fleet: { slots: 4, isolated: true, leases } },
		});
		const second = queueRelay(sim, inputs, "octo/public");
		await sim.deliver(isolated.answerer.webhook);
		expect(job(sim, "route", second.runId).outputs.get("runner")).toBe("hobo");
		expect(job(sim, "route", second.runId).outputs.get("step")).toBe("fleet");
	});
});

describe("relay mode keeps a relay job from waiting forever", () => {
	it("R13: a relay job whose webhook never arrived is answered by the next rescue poll", async () => {
		const sim = new GithubSimulator();
		turnOn(sim);
		const node = relayNode(sim);
		sim.dropNextWebhook();
		const { runId } = queueRelay(sim);
		await sim.deliver(node.answerer.webhook);
		expect(job(sim, "route", runId).status).toBe("queued");
		sim.advance(30_000);
		const rescue = await node.answerer.rescue(CONNECTIONS);
		expect(rescue.queued).toBe(1);
		expect(rescue.outcomes[0]?.kind).toBe("answered");
		expect(job(sim, "route", runId).conclusion).toBe("success");
		expect(job(sim, "build", runId).labels).toEqual(["ubuntu-24.04"]);
		// The next poll finds nothing left to answer.
		expect((await node.answerer.rescue(CONNECTIONS)).queued).toBe(0);
	});

	it("answers a job GitHub offered in place of the original, then starts again for the original", async () => {
		const sim = new GithubSimulator();
		turnOn(sim);
		const node = relayNode(sim);
		sim.dropNextWebhook();
		const older = queueRelay(sim);
		sim.advance(1_000);
		const newer = queueRelay(sim);
		const outcome = await node.answerer.answer({
			installationId: 1,
			repository: REPO,
			jobId: newer.relay.id,
			runId: newer.runId,
			runAttempt: 1,
			name: "route",
			labels: ["hobo-relay"],
			queuedAtMs: newer.relay.queuedAtMs,
		});
		expect(outcome.kind).toBe("answered");
		expect(outcome.answered.map((entry) => entry.runId)).toEqual([
			older.runId,
			newer.runId,
		]);
		expect(job(sim, "route", older.runId).conclusion).toBe("success");
		expect(job(sim, "route", newer.runId).conclusion).toBe("success");
		expect(job(sim, "route", newer.runId).runnerName).toMatch(/-2$/u);
		expect(sim.runners()).toEqual([]);
	});

	it("fails a job that asked for the relay label but is no relay job, and runs none of it", async () => {
		const sim = new GithubSimulator();
		turnOn(sim);
		const node = relayNode(sim);
		const stray = sim.queueJob({
			repository: REPO,
			name: "test",
			labels: ["hobo-relay"],
			steps: [{ uses: "actions/checkout@v4", with: new Map() }],
		});
		await sim.deliver(node.answerer.webhook);
		const done = sim.jobs().find((entry) => entry.id === stray.id);
		expect(done?.conclusion).toBe("failure");
		expect(done?.annotations[0]).toMatch(/never runs a job's steps/u);
		expect(await decisions(node)).toHaveLength(0);
	});

	it("creates the runner on the organization when the repository refuses", async () => {
		const sim = new GithubSimulator();
		turnOn(sim);
		const transport = simulatorTransport(sim);
		const node = relayNode(sim, {
			transport: {
				request: (installationId, path, method, body, ifNoneMatch) =>
					path === `/repos/${REPO}/actions/runners/generate-jitconfig`
						? Promise.resolve(new Response("{}", { status: 403 }))
						: transport.request(
								installationId,
								path,
								method,
								body,
								ifNoneMatch,
							),
			},
		});
		const { runId } = queueRelay(sim);
		await sim.deliver(node.answerer.webhook);
		expect(job(sim, "route", runId).conclusion).toBe("success");
		expect(
			sim
				.requests()
				.some(
					(request) =>
						request.path === "/orgs/octo/actions/runners/generate-jitconfig" &&
						request.status === 201,
				),
		).toBe(true);
	});

	it("sweeps leftover relay runners once their run has ended, and keeps the rest", async () => {
		const sim = new GithubSimulator();
		turnOn(sim);
		const node = relayNode(sim);
		const live = sim.queueJob({
			repository: REPO,
			name: "slow",
			labels: ["linux"],
		});
		const ended = sim.queueJob({
			repository: REPO,
			name: "gone",
			labels: ["linux"],
		});
		const leftover = `hobo-relay-${ended.runId}-${ended.id}-1`;
		const current = `hobo-relay-${live.runId}-${live.id}-1`;
		for (const name of [leftover, current])
			sim.registerRunner({
				name,
				labels: ["hobo-relay"],
				repository: REPO,
				ephemeral: true,
				online: false,
			});
		sim.registerRunner({
			name: "build-box",
			labels: ["linux"],
			repository: REPO,
			online: false,
		});
		sim.cancelRun(ended.runId);
		const sweep = await node.answerer.sweep(CONNECTIONS);
		expect(sweep.deleted).toEqual([leftover]);
		expect(
			sim
				.runners()
				.map((runner) => runner.name)
				.sort(),
		).toEqual(["build-box", current]);
		expect(relayRunnerRun(current)).toBe(live.runId);
		expect(relayRunnerRun("build-box")).toBeUndefined();
	});
});

/** A transport that answers `fail` instead of the simulator while it says so. */
function flakyTransport(
	sim: GithubSimulator,
	fail: (path: string, method: string | undefined) => Response | undefined,
): GithubTransport {
	const transport = simulatorTransport(sim);
	return {
		request: (installationId, path, method, body, ifNoneMatch) =>
			Promise.resolve(fail(path, method)).then(
				(failed) =>
					failed ??
					transport.request(installationId, path, method, body, ifNoneMatch),
			),
	};
}

function queuedOf(relay: SimulatedJob, name = "route") {
	return {
		installationId: 1,
		repository: relay.repository,
		jobId: relay.id,
		runId: relay.runId,
		runAttempt: 1,
		name,
		labels: ["hobo-relay"],
		queuedAtMs: relay.queuedAtMs,
	};
}

describe("relay mode recovers from GitHub's errors and a node that died", () => {
	it("asks again after a read of the job fails, and the next rescue answers it", async () => {
		const sim = new GithubSimulator();
		turnOn(sim);
		let failures = 1;
		const node = relayNode(sim, {
			transport: flakyTransport(sim, (path) => {
				if (failures > 0 && /\/actions\/jobs\/\d+$/u.test(path)) {
					failures -= 1;
					return new Response("bad gateway", { status: 502 });
				}
				return undefined;
			}),
		});
		sim.dropNextWebhook();
		const { runId } = queueRelay(sim);
		const first = await node.answerer.rescue(CONNECTIONS);
		expect(first.outcomes).toEqual([
			{ kind: "skipped", reason: "read-failed", answered: [] },
		]);
		expect(job(sim, "route", runId).status).toBe("queued");
		sim.advance(30_000);
		const second = await node.answerer.rescue(CONNECTIONS);
		expect(second.outcomes[0]?.kind).toBe("answered");
		expect(job(sim, "route", runId).conclusion).toBe("success");
	});

	it("still remembers a job GitHub says is gone, so a redelivery costs one read", async () => {
		const sim = new GithubSimulator();
		turnOn(sim);
		const node = relayNode(sim);
		const { relay } = queueRelay(sim);
		sim.cancelRun(relay.runId);
		expect(await node.answerer.answer(queuedOf(relay))).toMatchObject({
			kind: "skipped",
			reason: "not-queued",
		});
		const before = sim.requests().length;
		expect(await node.answerer.answer(queuedOf(relay))).toMatchObject({
			kind: "skipped",
			reason: "in-flight",
		});
		expect(sim.requests()).toHaveLength(before);
	});

	it("sweeps a leftover runner of a node that died, so the job it fenced is answered", async () => {
		const sim = new GithubSimulator();
		turnOn(sim);
		const node = relayNode(sim);
		sim.dropNextWebhook();
		const { relay, runId } = queueRelay(sim);
		// A node created the first runner for this job and died before using it.
		sim.registerRunner({
			name: `hobo-relay-${relay.runId}-${relay.id}-1`,
			labels: ["hobo-relay"],
			repository: REPO,
			ephemeral: true,
			online: false,
		});
		const rounds: unknown[] = [];
		for (
			let poll = 0;
			poll < 4 && job(sim, "route", runId).status === "queued";
			poll += 1
		) {
			const rescue = await node.answerer.rescue(CONNECTIONS);
			rounds.push(
				rescue.outcomes.map((outcome) =>
					outcome.kind === "skipped" ? outcome.reason : outcome.kind,
				),
			);
			await node.answerer.sweep(CONNECTIONS);
			sim.advance(RELAY_STALE_RUNNER_MS);
		}
		expect(rounds).toEqual([
			["runner-exists"],
			["runner-exists"],
			["answered"],
		]);
		expect(job(sim, "route", runId).conclusion).toBe("success");
		expect(sim.runners()).toEqual([]);
	});

	it("keeps a relay runner that is online or busy, and deletes one left offline", async () => {
		const sim = new GithubSimulator();
		turnOn(sim);
		const node = relayNode(sim);
		const names = ["offline", "online", "busy"].map((kind) => {
			const live = sim.queueJob({ repository: REPO, name: kind, labels: [] });
			return `hobo-relay-${live.runId}-${live.id}-1`;
		});
		const [offline, online, busy] = names;
		for (const [name, isOnline] of [
			[offline, false],
			[online, true],
			[busy, true],
		] as const)
			sim.registerRunner({
				name: name ?? "",
				labels: ["hobo-relay"],
				repository: REPO,
				ephemeral: true,
				online: isOnline,
			});
		queueRelay(sim, undefined);
		// The busy runner takes the queued relay job and holds it.
		const session = await new SimulatedRunnerService(sim).open(
			testJitConfig(busy ?? ""),
		);
		expect(await session.nextJob(1_000)).toBeDefined();
		expect((await node.answerer.sweep(CONNECTIONS)).deleted).toEqual([]);
		sim.advance(RELAY_STALE_RUNNER_MS - 1);
		expect((await node.answerer.sweep(CONNECTIONS)).deleted).toEqual([]);
		sim.advance(1);
		expect((await node.answerer.sweep(CONNECTIONS)).deleted).toEqual([offline]);
		expect(
			sim
				.runners()
				.map((runner) => runner.name)
				.sort(),
		).toEqual([busy, online].sort());
		expect(sim.runners().find((runner) => runner.name === busy)?.busy).toBe(
			true,
		);
		await session.close();
	});

	it("keeps another node's online organization runner for a repository this node does not serve", async () => {
		const sim = new GithubSimulator();
		sim.addRepository("octo/other", true);
		turnOn(sim);
		const node = relayNode(sim);
		// A peer serving octo/other created this runner and waits for its offer.
		const waiting = sim.queueJob({
			repository: "octo/other",
			name: "route",
			labels: ["hobo-relay"],
		});
		const name = `hobo-relay-${waiting.runId}-${waiting.id}-1`;
		sim.registerRunner({
			name,
			labels: ["hobo-relay"],
			org: "octo",
			ephemeral: true,
		});
		for (let round = 0; round < 3; round += 1) {
			expect((await node.answerer.sweep(CONNECTIONS)).deleted).toEqual([]);
			sim.advance(RELAY_STALE_RUNNER_MS);
		}
		expect(sim.runners().map((runner) => runner.name)).toEqual([name]);
		expect(job(sim, "route", waiting.runId).status).toBe("queued");
	});
});

describe("relay mode answers each repository only as it asks", () => {
	function orgRunnerNode(
		sim: GithubSimulator,
		accounts: ReadonlyMap<string, string>,
		looked: string[],
	): RelayNode {
		const transport = simulatorTransport(sim);
		const journal = new InMemoryRouteJournal();
		const registry = new InMemoryMachineRegistry();
		const answerer = createRelayAnswerer({
			relayJobs: { answer: true, label: "hobo-relay" },
			github: {
				// The repository refuses, so the runner is created on the organization.
				request: (installationId, path, method, body, ifNoneMatch) =>
					path === `/repos/${REPO}/actions/runners/generate-jitconfig`
						? Promise.resolve(new Response("{}", { status: 403 }))
						: transport.request(
								installationId,
								path,
								method,
								body,
								ifNoneMatch,
							),
			},
			runnerService: new SimulatedRunnerService(sim),
			readJitConfig: (_encoded, runnerName) => testJitConfig(runnerName),
			account: async (queued) => {
				looked.push(queued.repository);
				return accounts.get(queued.repository);
			},
			facts: (accountId) =>
				new StoreRouteFacts({
					accountId,
					fleet: undefined,
					machines: registry,
					readers: undefined,
					spend: undefined,
					health: undefined,
					minutes: undefined,
					onWarning: undefined,
				}),
			journal,
			node: "node-a",
			webhookSecret: sim.webhookSecret,
			nowMs: () => sim.nowMs(),
		});
		return { answerer, journal, registry };
	}

	it("fails another repository's relay job an organization runner was offered when that repository left relay mode off", async () => {
		const sim = new GithubSimulator();
		sim.addRepository("octo/other", true);
		turnOn(sim);
		const looked: string[] = [];
		const node = orgRunnerNode(sim, new Map([[REPO, ACCOUNT]]), looked);
		sim.dropNextWebhook();
		const other = queueRelay(sim, undefined, "octo/other");
		sim.advance(1_000);
		sim.dropNextWebhook();
		const mine = queueRelay(sim);
		const outcome = await node.answerer.answer(queuedOf(mine.relay));
		expect(outcome.kind).toBe("answered");
		expect(outcome.answered.map((entry) => entry.repository)).toEqual([
			"octo/other",
			REPO,
		]);
		expect(looked).toEqual([REPO, "octo/other"]);
		const refused = job(sim, "route", other.runId);
		expect(refused.conclusion).toBe("failure");
		expect(refused.annotations[0]).toMatch(
			/Relay mode is not on for octo\/other/u,
		);
		expect(refused.outputs.get("runner")).toBeUndefined();
		expect(job(sim, "route", mine.runId).conclusion).toBe("success");
		expect(await decisions(node)).toHaveLength(1);
	});

	it("answers another repository's relay job with that repository's own account when it turned relay mode on", async () => {
		const sim = new GithubSimulator();
		sim.addRepository("octo/other", true);
		turnOn(sim);
		turnOn(sim, ["github"], "octo/other");
		const looked: string[] = [];
		const node = orgRunnerNode(
			sim,
			new Map([
				[REPO, ACCOUNT],
				["octo/other", "acct-other"],
			]),
			looked,
		);
		sim.dropNextWebhook();
		const other = queueRelay(sim, undefined, "octo/other");
		sim.advance(1_000);
		sim.dropNextWebhook();
		const mine = queueRelay(sim);
		expect((await node.answerer.answer(queuedOf(mine.relay))).kind).toBe(
			"answered",
		);
		expect(job(sim, "route", other.runId).conclusion).toBe("success");
		const theirs = await node.journal.decisions({
			accountId: "acct-other",
			repository: undefined,
			sinceMs: 0,
			limit: 100,
		});
		expect(decided(theirs)).toHaveLength(1);
		expect(decided(theirs)[0]).toMatchObject({ accountId: "acct-other" });
		expect(await decisions(node)).toHaveLength(1);
	});

	it("recognises the original job when its display name is not its id in the workflow", async () => {
		const sim = new GithubSimulator();
		turnOn(sim);
		const node = relayNode(sim);
		const { relay, runId } = queueRelay(sim);
		const outcome = await node.answerer.answer(
			queuedOf(relay, "Pick a runner"),
		);
		expect(outcome.kind).toBe("answered");
		expect(outcome.answered).toHaveLength(1);
		expect(job(sim, "route", runId).conclusion).toBe("success");
		expect(
			sim
				.requests()
				.filter((request) => request.path.endsWith("/generate-jitconfig")),
		).toHaveLength(1);
	});
});

describe("R16: any mesh node may answer, and only one does", () => {
	function meshNode(
		sim: GithubSimulator,
		mesh: ReturnType<typeof createMemoryMesh>,
		id: string,
	) {
		const coordinator = createMeshCoordinator({
			self: () => ({
				id,
				freeSlots: 1,
				healthy: true,
				labels: ["hobo-relay"],
				validUntilMs: sim.nowMs() + 60_000,
			}),
			board: mesh.board,
			claims: mesh.claims,
			stepMs: 20_000,
			viewMaxAgeMs: 0,
			now: () => sim.nowMs(),
		});
		return {
			coordinator,
			node: relayNode(sim, { node: id, turn: coordinator }),
		};
	}

	it("with the first node down, the second answers the relay job exactly once", async () => {
		const sim = new GithubSimulator();
		turnOn(sim);
		const mesh = createMemoryMesh({ now: () => sim.nowMs() });
		const hosted = meshNode(sim, mesh, "hosted");
		const box = meshNode(sim, mesh, "box");
		await hosted.coordinator.advertise();
		await box.coordinator.advertise();
		const { runId } = queueRelay(sim);
		// The hosted node is down: the queued webhook reaches nobody.
		await sim.deliver(async () => new Response("unavailable", { status: 503 }));
		let polls = 0;
		while (job(sim, "route", runId).status === "queued" && polls < 6) {
			await box.node.answerer.rescue(CONNECTIONS);
			polls += 1;
			if (job(sim, "route", runId).status === "queued") sim.advance(20_000);
		}
		expect(job(sim, "route", runId).conclusion).toBe("success");
		expect(await decisions(box.node)).toHaveLength(1);
		expect(await decisions(hosted.node)).toHaveLength(0);
		// The hosted node comes back: nothing is left for it, and the box answers nothing twice.
		expect((await hosted.node.answerer.rescue(CONNECTIONS)).queued).toBe(0);
		expect((await box.node.answerer.rescue(CONNECTIONS)).queued).toBe(0);
		expect(
			sim
				.requests()
				.filter((request) => request.path.endsWith("/generate-jitconfig")),
		).toHaveLength(1);
	});

	it("with both nodes up, one answers and the other is told the job is held", async () => {
		const sim = new GithubSimulator();
		turnOn(sim);
		const mesh = createMemoryMesh({ now: () => sim.nowMs() });
		const first = meshNode(sim, mesh, "hosted");
		const second = meshNode(sim, mesh, "box");
		await first.coordinator.advertise();
		await second.coordinator.advertise();
		const { relay, runId } = queueRelay(sim);
		const queued = {
			installationId: 1,
			repository: REPO,
			jobId: relay.id,
			runId,
			runAttempt: 1,
			name: "route",
			labels: ["hobo-relay"],
			queuedAtMs: relay.queuedAtMs,
		};
		sim.advance(20_000);
		const outcomes = await Promise.all([
			first.node.answerer.answer(queued),
			second.node.answerer.answer(queued),
		]);
		expect(
			outcomes.filter((outcome) => outcome.kind === "answered"),
		).toHaveLength(1);
		expect(
			outcomes.find((outcome) => outcome.kind === "skipped"),
		).toMatchObject({ reason: "claimed-elsewhere" });
		expect(job(sim, "route", runId).conclusion).toBe("success");
	});
});

describe("X01: the answerer asks GitHub for no log, secret or repository content", () => {
	it("reads only .hobo/ci.json of the repository, and nothing under logs or secrets", async () => {
		const sim = new GithubSimulator();
		turnOn(sim);
		const node = relayNode(sim);
		sim.dropNextWebhook();
		queueRelay(sim);
		await node.answerer.rescue(CONNECTIONS);
		queueRelay(sim);
		await sim.deliver(node.answerer.webhook);
		await node.answerer.sweep(CONNECTIONS);
		const requests = sim.requests();
		expect(requests.length).toBeGreaterThan(0);
		expect(requests.filter((request) => request.area === "logs")).toEqual([]);
		for (const request of requests) {
			expect(request.path).not.toMatch(
				/\/logs\b|\/secrets\b|\/variables\b|\/tarball\b|\/zipball\b|\/git\/blobs\b|\/git\/trees\b/u,
			);
			if (request.path.includes("/contents/"))
				expect(request.path).toBe(`/repos/${REPO}/contents/.hobo%2Fci.json`);
		}
		const answered = sim.jobs().filter((entry) => entry.name === "route");
		expect(answered.every((entry) => entry.conclusion === "success")).toBe(
			true,
		);
	});
});
