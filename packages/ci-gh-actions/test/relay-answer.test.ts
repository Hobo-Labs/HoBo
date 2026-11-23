import { create } from "@bufbuild/protobuf";
import { type RelayJobMessage, RelayJobAnswerSchema } from "@hobo/ci";
import { createMemoryMesh, createMeshCoordinator } from "@hobo/ci/mesh";
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
} from "../src/relay-answer/index.js";
import { testJitConfig } from "../src/runner-protocol/port.js";
import {
	GithubSimulator,
	SimulatedRunnerService,
	simulatorTransport,
} from "./support/github-simulator/index.js";
import type { SimulatedJob } from "./support/github-simulator-port.js";

const REPO = "octo/app";
const ACCOUNT = "acct-1";
const CONNECTIONS = [{ installationId: 1, repository: REPO }];
const TITLE_CHECK = "hobo-labs/hobo/checks/pr-title@v1";

type NodeSetup = Readonly<{
	node?: string;
	answer?: boolean;
	turn?: RelayTurn;
	transport?: GithubTransport;
}>;

type RelayNode = Readonly<{
	answerer: RelayAnswerer;
	checked: RelayJobMessage[];
}>;

function passingChecks(checked: RelayJobMessage[]) {
	return async (message: RelayJobMessage) => {
		checked.push(message);
		return create(RelayJobAnswerSchema, {
			jobId: message.jobId,
			planId: message.planId,
			conclusion: "succeeded",
		});
	};
}

function relayNode(sim: GithubSimulator, setup: NodeSetup = {}): RelayNode {
	const checked: RelayJobMessage[] = [];
	const options: RelayAnswererOptions = {
		relayJobs: { answer: setup.answer ?? true, label: "hobo-relay" },
		github: setup.transport ?? simulatorTransport(sim),
		runnerService: new SimulatedRunnerService(sim),
		readJitConfig: (_encoded, runnerName) => testJitConfig(runnerName),
		account: async () => ACCOUNT,
		node: setup.node ?? "node-a",
		turn: setup.turn,
		checks: passingChecks(checked),
		webhookSecret: sim.webhookSecret,
		nowMs: () => sim.nowMs(),
	};
	return { answerer: createRelayAnswerer(options), checked };
}

function turnOn(sim: GithubSimulator, repository = REPO): void {
	sim.putFile(
		repository,
		RELAY_CONFIG_PATH,
		JSON.stringify({ relayJobs: { answer: true } }),
	);
}

type QueuedRelay = Readonly<{ relay: SimulatedJob; runId: number }>;

function queueRelay(sim: GithubSimulator, repository = REPO): QueuedRelay {
	const relay = sim.queueJob({
		repository,
		name: "title",
		labels: ["hobo-relay"],
		steps: [{ uses: TITLE_CHECK, with: new Map([["types", "feat,fix"]]) }],
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

describe("relay mode (R01): a queued check job is answered by the relay", () => {
	it("answers within five seconds of the queued webhook, on no runner, through the checks", async () => {
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
		const title = job(sim, "title", runId);
		expect(title).toMatchObject({ status: "completed", conclusion: "success" });
		expect(title.completedAtMs ?? 0).toBeLessThanOrEqual(
			title.queuedAtMs + 5_000,
		);
		expect(elapsed).toBeLessThan(5_000);
		expect(title.outputs.size).toBe(0);
		expect(title.runnerName).toMatch(/^hobo-relay-\d+-\d+-1$/u);
		expect(sim.runners()).toEqual([]);
		expect(node.checked.map((message) => message.steps[0]?.uses)).toEqual([
			TITLE_CHECK,
		]);
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
		expect(job(sim, "title", runId).conclusion).toBe("success");
		expect(node.checked).toHaveLength(1);
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
		expect(job(sim, "title", runId).status).toBe("queued");
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
			name: "title",
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

describe("relay mode keeps a relay job from waiting forever", () => {
	it("R13: a relay job whose webhook never arrived is answered by the next rescue poll", async () => {
		const sim = new GithubSimulator();
		turnOn(sim);
		const node = relayNode(sim);
		sim.dropNextWebhook();
		const { runId } = queueRelay(sim);
		await sim.deliver(node.answerer.webhook);
		expect(job(sim, "title", runId).status).toBe("queued");
		sim.advance(30_000);
		const rescue = await node.answerer.rescue(CONNECTIONS);
		expect(rescue.queued).toBe(1);
		expect(rescue.outcomes[0]?.kind).toBe("answered");
		expect(job(sim, "title", runId).conclusion).toBe("success");
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
			name: "title",
			labels: ["hobo-relay"],
			queuedAtMs: newer.relay.queuedAtMs,
		});
		expect(outcome.kind).toBe("answered");
		expect(outcome.answered.map((entry) => entry.runId)).toEqual([
			older.runId,
			newer.runId,
		]);
		expect(job(sim, "title", older.runId).conclusion).toBe("success");
		expect(job(sim, "title", newer.runId).conclusion).toBe("success");
		expect(job(sim, "title", newer.runId).runnerName).toMatch(/-2$/u);
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
		expect(node.checked).toHaveLength(0);
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
		expect(job(sim, "title", runId).conclusion).toBe("success");
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

function queuedOf(relay: SimulatedJob, name = "title") {
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
		expect(job(sim, "title", runId).status).toBe("queued");
		sim.advance(30_000);
		const second = await node.answerer.rescue(CONNECTIONS);
		expect(second.outcomes[0]?.kind).toBe("answered");
		expect(job(sim, "title", runId).conclusion).toBe("success");
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
			poll < 4 && job(sim, "title", runId).status === "queued";
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
		expect(job(sim, "title", runId).conclusion).toBe("success");
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
		queueRelay(sim);
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
		const waiting = sim.queueJob({
			repository: "octo/other",
			name: "title",
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
		expect(job(sim, "title", waiting.runId).status).toBe("queued");
	});
});

describe("relay mode answers each repository only as it asks", () => {
	function orgRunnerNode(
		sim: GithubSimulator,
		accounts: ReadonlyMap<string, string>,
		looked: string[],
	): RelayNode {
		const transport = simulatorTransport(sim);
		const checked: RelayJobMessage[] = [];
		const answerer = createRelayAnswerer({
			relayJobs: { answer: true, label: "hobo-relay" },
			github: {
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
			checks: passingChecks(checked),
			node: "node-a",
			webhookSecret: sim.webhookSecret,
			nowMs: () => sim.nowMs(),
		});
		return { answerer, checked };
	}

	it("fails another repository's relay job an organization runner was offered when that repository left relay mode off", async () => {
		const sim = new GithubSimulator();
		sim.addRepository("octo/other", true);
		turnOn(sim);
		const looked: string[] = [];
		const node = orgRunnerNode(sim, new Map([[REPO, ACCOUNT]]), looked);
		sim.dropNextWebhook();
		const other = queueRelay(sim, "octo/other");
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
		const refused = job(sim, "title", other.runId);
		expect(refused.conclusion).toBe("failure");
		expect(refused.annotations[0]).toMatch(
			/Relay mode is not on for octo\/other/u,
		);
		expect(refused.annotations[0]).toMatch(/Run the job again/u);
		expect(job(sim, "title", mine.runId).conclusion).toBe("success");
		expect(node.checked.map((message) => message.repository)).toEqual([REPO]);
	});

	it("answers another repository's relay job with that repository's own account when it turned relay mode on", async () => {
		const sim = new GithubSimulator();
		sim.addRepository("octo/other", true);
		turnOn(sim);
		turnOn(sim, "octo/other");
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
		const other = queueRelay(sim, "octo/other");
		sim.advance(1_000);
		sim.dropNextWebhook();
		const mine = queueRelay(sim);
		expect((await node.answerer.answer(queuedOf(mine.relay))).kind).toBe(
			"answered",
		);
		expect(job(sim, "title", other.runId).conclusion).toBe("success");
		expect(node.checked.map((message) => message.repository)).toEqual([
			"octo/other",
			REPO,
		]);
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
		expect(job(sim, "title", runId).conclusion).toBe("success");
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
		await sim.deliver(async () => new Response("unavailable", { status: 503 }));
		let polls = 0;
		while (job(sim, "title", runId).status === "queued" && polls < 6) {
			await box.node.answerer.rescue(CONNECTIONS);
			polls += 1;
			if (job(sim, "title", runId).status === "queued") sim.advance(20_000);
		}
		expect(job(sim, "title", runId).conclusion).toBe("success");
		expect(box.node.checked).toHaveLength(1);
		expect(hosted.node.checked).toHaveLength(0);
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
			name: "title",
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
		expect(job(sim, "title", runId).conclusion).toBe("success");
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
		const answered = sim.jobs().filter((entry) => entry.name === "title");
		expect(answered.every((entry) => entry.conclusion === "success")).toBe(
			true,
		);
	});
});
