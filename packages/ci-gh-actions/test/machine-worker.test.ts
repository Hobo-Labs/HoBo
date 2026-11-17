import {
	chooseMachine,
	machineOnline,
	registryMachineCandidates,
} from "@hobo/ci";
import { generateMeshIdentity } from "@hobo/ci/mesh";
import { InMemoryMachineRegistry } from "@hobo/ci/runner-order/testing";
import { describe, expect, it } from "vitest";
import {
	type MachineProfile,
	machineRunsOnLabel,
	registryAdvertSink,
} from "../src/machine-worker/advert.js";
import {
	containerExecutor,
	type JobExecutor,
} from "../src/machine-worker/executor.js";
import { githubQueueJobSource } from "../src/machine-worker/jobs.js";
import { FakeContainerDriver } from "../src/machine-worker/testing.js";
import {
	createMachineWorker,
	type MachineWorker,
	type MachineWorkerEvent,
} from "../src/machine-worker/worker.js";
import { FakeGithubRunnerService } from "../src/runner-protocol/fake-service.js";
import { GithubSimulator } from "./support/github-simulator/index.js";
import {
	simulatedRunnerProgram,
	simulatorMachineGithub,
} from "./support/machine-connect-simulator.js";

const PROFILE: MachineProfile = {
	id: "m-7f3a",
	name: "studio",
	os: "linux",
	arch: "x64",
	accountId: "local",
	ownerId: "42",
	ownerLogin: "octocat",
	isolation: "container",
};
const LABEL = machineRunsOnLabel(PROFILE.id);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

type Setup = Readonly<{
	github: GithubSimulator;
	registry: InMemoryMachineRegistry;
	docker: FakeContainerDriver;
	worker: MachineWorker;
	events: MachineWorkerEvent[];
	runs: ReturnType<typeof simulatedRunnerProgram>["runs"];
	release: () => void;
}>;

function setup(
	options: Readonly<{
		concurrency?: number;
		hold?: boolean;
		rewriteJit?: (encoded: string) => string;
		registry?: InMemoryMachineRegistry;
		executor?: (docker: FakeContainerDriver) => JobExecutor;
		repositories?: readonly string[];
	}> = {},
): Setup {
	const github = new GithubSimulator();
	github.addRepository("octo/app", true);
	github.addRepository("octo/site", false);
	const registry = options.registry ?? new InMemoryMachineRegistry();
	let release = () => {};
	const gate = () =>
		new Promise<void>((resolve) => {
			release = resolve;
		});
	const { program, runs } = simulatedRunnerProgram(
		github,
		options.hold ? { hold: gate } : {},
	);
	const docker = new FakeContainerDriver(program);
	const events: MachineWorkerEvent[] = [];
	const machineGithub = simulatorMachineGithub(
		github,
		options.rewriteJit ? { rewriteJit: options.rewriteJit } : {},
	);
	const worker = createMachineWorker({
		profile: PROFILE,
		identity: generateMeshIdentity().identity,
		sink: registryAdvertSink(registry, {
			accountId: "local",
			ownerId: "42",
			ownerLogin: "octocat",
		}),
		jobs: githubQueueJobSource({
			github: machineGithub,
			repositories: options.repositories ?? ["octo/app"],
			label: LABEL,
			pollMs: 0,
		}),
		github: machineGithub,
		executor:
			options.executor?.(docker) ??
			containerExecutor({
				docker,
				image: "runner:test",
				arch: "x64",
				env: {
					GH_TOKEN: "gho_secret",
					PATH: "/usr/bin",
					HTTPS_PROXY: "http://proxy:3128",
				},
				wait: () => tick(),
			}),
		concurrency: options.concurrency ?? 1,
		sharing: "only_me",
		now: () => github.nowMs(),
		emit: (event) => events.push(event),
	});
	return {
		github,
		registry,
		docker,
		worker,
		events,
		runs,
		release: () => release(),
	};
}

async function settle(worker: MachineWorker): Promise<void> {
	for (let turn = 0; turn < 500 && worker.status().running > 0; turn++)
		await tick();
	expect(worker.status().running).toBe(0);
}

function queue(github: GithubSimulator, repository = "octo/app") {
	return github.queueJob({ repository, name: "build", labels: [LABEL] });
}

function choose(registry: InMemoryMachineRegistry, nowMs: number) {
	return registryMachineCandidates(registry, {
		accountId: "local",
		nowMs,
		readers: new Set(["42"]),
	}).then((candidates) =>
		chooseMachine(candidates, {
			labels: ["self-hosted"],
			repository: "octo/app",
			starterId: "42",
			triggeredById: "42",
			preferMachineId: undefined,
			avoidMachineId: undefined,
		}),
	);
}

function types(events: readonly MachineWorkerEvent[]): string[] {
	return events.map((event) => event.type);
}

describe("the machine worker", () => {
	it("advertises a signed machine the registry keeps, and renews it every 30 s", async () => {
		const { github, registry, worker, events } = setup();
		await worker.tick();
		const [kept] = await registry.list("local");
		expect(kept).toMatchObject({
			id: PROFILE.id,
			runsOn: LABEL,
			labels: ["self-hosted", "Linux", "X64"],
			isolation: "container",
			slots: 1,
			busy: 0,
			ownerId: "42",
		});
		expect(types(events)).toEqual(["machine.connected", "worker.advertised"]);
		github.advance(29_000);
		await worker.tick();
		expect(types(events)).toHaveLength(2);
		github.advance(1_000);
		await worker.tick();
		expect(types(events)).toHaveLength(3);
	});

	it("runs each job on its own one-job runner in a fresh container, and keeps no runner", async () => {
		const { github, docker, worker, runs } = setup();
		const first = queue(github);
		await worker.tick();
		await settle(worker);
		const second = queue(github);
		await worker.tick();
		await settle(worker);

		expect(runs.map((run) => run.jobId)).toEqual([first.id, second.id]);
		expect(new Set(runs.map((run) => run.runner)).size).toBe(2);
		expect(
			github.jobs().filter((job) => job.conclusion === "success"),
		).toHaveLength(2);
		expect(docker.containers).toHaveLength(2);
		for (const container of docker.containers) {
			expect(container.started).toBe(true);
			expect(container.removed).toBe(true);
		}
		expect(github.runners()).toEqual([]);
	});

	it("gives the job container none of the CLI's environment", async () => {
		const { github, docker, worker } = setup();
		queue(github);
		await worker.tick();
		await settle(worker);
		const env = docker.containers[0]?.spec.env ?? {};
		expect(Object.keys(env).sort()).toEqual([
			"HOBO_CI_RUNNER_SHA256",
			"HOBO_CI_RUNNER_URL",
			"HTTPS_PROXY",
		]);
		expect(JSON.stringify(docker.containers[0]?.commands)).not.toContain(
			"gho_secret",
		);
	});

	it("refuses a public repository's job and a fork's pull request without making a runner", async () => {
		const { github, worker, events, docker } = setup({
			repositories: ["octo/site", "octo/app"],
		});
		queue(github, "octo/site");
		github.queueJob({
			repository: "octo/app",
			name: "pr",
			labels: [LABEL],
			fork: true,
		});
		await worker.tick();
		await worker.tick();
		expect(
			types(events).filter((type) => type === "worker.job_refused"),
		).toHaveLength(2);
		// Offered again after the queue's ten minutes, and not refused again.
		github.advance(11 * 60_000);
		await worker.tick();
		expect(
			types(events).filter((type) => type === "worker.job_refused"),
		).toHaveLength(2);
		expect(docker.containers).toEqual([]);
		expect(
			github
				.requests()
				.filter((request) => request.path.endsWith("/generate-jitconfig")),
		).toEqual([]);
	});

	it("checks the one-job configuration before anything uses it", async () => {
		const { github, worker, events, docker } = setup();
		// A configuration for another runner than the one asked for.
		const other = setup({
			rewriteJit: () =>
				new FakeGithubRunnerService().jitConfig("hobo-machine-someone-else-1"),
		});
		queue(other.github);
		await other.worker.tick();
		await settle(other.worker);
		const failed = other.events.find(
			(event) => event.type === "worker.job_failed",
		);
		expect(failed && "detail" in failed ? failed.detail : "").toMatch(
			/refused before use: the configuration is for runner/u,
		);
		expect(other.docker.containers).toEqual([]);
		expect(other.github.runners()).toEqual([]);
		// The unchanged configuration passes.
		queue(github);
		await worker.tick();
		await settle(worker);
		expect(types(events)).toContain("worker.job_finished");
		expect(docker.containers).toHaveLength(1);
	});

	it("takes no job while paused, and the registry keeps the pause", async () => {
		const { github, registry, worker, docker } = setup();
		await worker.tick();
		await worker.setPaused(true);
		queue(github);
		await worker.tick();
		expect(docker.containers).toEqual([]);
		expect((await registry.list("local"))[0]?.paused).toBe(true);
		await worker.setPaused(false);
		await worker.tick();
		await settle(worker);
		expect(docker.containers).toHaveLength(1);
	});

	it("honours a pause the owner set elsewhere, on the next renewal", async () => {
		const { github, registry, worker, docker } = setup();
		await worker.tick();
		await registry.setPaused(PROFILE.id, true, "octocat");
		github.advance(30_000);
		queue(github);
		await worker.tick();
		expect(worker.status().paused).toBe(true);
		expect(docker.containers).toEqual([]);
	});

	it("runs jobs at once up to its concurrency, and advertises the busy slots", async () => {
		const { github, registry, worker, docker, release } = setup({
			concurrency: 2,
			hold: true,
		});
		queue(github);
		queue(github);
		queue(github);
		await worker.tick();
		for (let turn = 0; turn < 20; turn++) await tick();
		expect(worker.status().running).toBe(2);
		expect(docker.alive()).toHaveLength(2);
		expect((await registry.list("local"))[0]?.busy).toBe(2);
		release();
	});

	it("drains on stop: offline at once, while running jobs finish", async () => {
		const { github, registry, worker, events, release, runs } = setup({
			concurrency: 2,
			hold: true,
		});
		queue(github);
		await worker.tick();
		for (let turn = 0; turn < 20; turn++) await tick();
		const draining = worker.drain();
		for (let turn = 0; turn < 20; turn++) await tick();
		// The job is still held, and the machine is already passed over.
		expect(worker.status().running).toBe(1);
		expect(types(events)).toContain("machine.disconnected");
		const [kept] = await registry.list("local");
		expect(kept && machineOnline(kept, github.nowMs())).toBe(false);
		expect(await choose(registry, github.nowMs())).toMatchObject({
			kind: "none",
			reason: "no_machine",
		});
		queue(github);
		await worker.tick();
		await worker.setPaused(true);
		const [still] = await registry.list("local");
		expect(still && machineOnline(still, github.nowMs())).toBe(false);
		release();
		await draining;
		expect(runs[0]?.finished).toBe(true);
		expect(runs).toHaveLength(1);
		const [after] = await registry.list("local");
		expect(after && machineOnline(after, github.nowMs())).toBe(false);
	});

	it("hands off on a second stop: the running job is stopped and its runner removed", async () => {
		const { github, registry, worker, docker, events } = setup({
			hold: true,
		});
		queue(github);
		await worker.tick();
		for (let turn = 0; turn < 20; turn++) await tick();
		await worker.handOff();
		// The advert is withdrawn before the running job is stopped.
		const order = types(events);
		expect(order.indexOf("machine.disconnected")).toBeLessThan(
			order.indexOf("worker.job_failed"),
		);
		const [kept] = await registry.list("local");
		expect(kept && machineOnline(kept, github.nowMs())).toBe(false);
		expect(docker.containers[0]?.stopped).toBe(true);
		expect(docker.containers[0]?.removed).toBe(true);
		// GitHub keeps a runner that held a job until it marks the job lost;
		// the stopped runner is offline and takes nothing more.
		expect(github.runners().map((runner) => runner.status)).toEqual([
			"offline",
		]);
		expect(types(events)).toContain("worker.job_failed");
		expect(types(events)).toContain("machine.disconnected");
	});

	it("stops for good when the registry says another key holds the machine", async () => {
		const registry = new InMemoryMachineRegistry();
		const first = setup({ registry });
		await first.worker.tick();
		const second = setup({ registry });
		queue(second.github);
		await second.worker.tick();
		expect(second.worker.status().refused).toMatch(/another key/u);
		expect(types(second.events)).toContain("machine.taken_over");
		expect(second.docker.containers).toEqual([]);
	});
});
