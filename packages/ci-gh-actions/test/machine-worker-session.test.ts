import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	chooseMachine,
	machineOnline,
	registryMachineCandidates,
} from "@hobo/ci";
import { InMemoryMachineRegistry } from "@hobo/ci/runner-order/testing";
import { describe, expect, it } from "vitest";
import {
	type MachineProfile,
	machineRunsOnLabel,
	registryAdvertSink,
} from "../src/machine-worker/advert.js";
import { containerExecutor } from "../src/machine-worker/executor.js";
import { githubQueueJobSource } from "../src/machine-worker/jobs.js";
import {
	githubOwner,
	loadMachine,
	MACHINE_KEY_FILE,
	machinePlatform,
	runMachineSession,
} from "../src/machine-worker/session.js";
import { FakeContainerDriver } from "../src/machine-worker/testing.js";
import {
	createMachineWorker,
	type MachineWorkerEvent,
} from "../src/machine-worker/worker.js";
import { GithubSimulator } from "./support/github-simulator/index.js";
import {
	simulatedRunnerProgram,
	simulatorMachineGithub,
} from "./support/machine-connect-simulator.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function until(check: () => boolean): Promise<void> {
	for (let turn = 0; turn < 2_000 && !check(); turn++) await tick();
	expect(check()).toBe(true);
}

async function connected(options: Readonly<{ hold?: boolean }> = {}) {
	const github = new GithubSimulator();
	github.addRepository("octo/app", true);
	const registry = new InMemoryMachineRegistry();
	const directory = await mkdtemp(join(tmpdir(), "hobo-machine-"));
	const machine = await loadMachine(directory, {
		name: undefined,
		defaultName: "studio",
	});
	let release = () => {};
	const { program, runs } = simulatedRunnerProgram(
		github,
		options.hold
			? {
					hold: () =>
						new Promise<void>((resolve) => {
							release = resolve;
						}),
				}
			: {},
	);
	const docker = new FakeContainerDriver(program);
	const machineGithub = simulatorMachineGithub(github);
	const profile: MachineProfile = {
		id: machine.id,
		name: machine.name,
		os: "linux",
		arch: "x64",
		accountId: "local",
		ownerId: "42",
		ownerLogin: "octocat",
		isolation: "container",
	};
	const label = machineRunsOnLabel(machine.id);
	const events: MachineWorkerEvent[] = [];
	const worker = createMachineWorker({
		profile,
		identity: machine.identity,
		sink: registryAdvertSink(registry, {
			accountId: "local",
			ownerId: "42",
			ownerLogin: "octocat",
		}),
		jobs: githubQueueJobSource({
			github: machineGithub,
			repositories: ["octo/app"],
			label,
			pollMs: 0,
		}),
		github: machineGithub,
		executor: containerExecutor({
			docker,
			image: "runner:test",
			arch: "x64",
			env: { GH_TOKEN: "gho_secret", PATH: "/usr/bin" },
			wait: () => tick(),
		}),
		concurrency: 1,
		sharing: "only_me",
		now: () => github.nowMs(),
		emit: (event) => events.push(event),
	});
	const session = runMachineSession({ worker, wait: () => tick() });
	return {
		github,
		registry,
		docker,
		events,
		runs,
		session,
		label,
		directory,
		machine,
		release: () => release(),
	};
}

describe("a machine connect session", () => {
	it("M01: connects, runs a routed job, and once stopped the next decision passes it over", async () => {
		const { github, registry, docker, session, label, runs } =
			await connected();
		await until(() => github.runners().length === 0 && runs.length === 0);
		const job = github.queueJob({
			repository: "octo/app",
			name: "build",
			labels: [label],
		});
		await until(() =>
			github.jobs().some((found) => found.conclusion === "success"),
		);
		expect(runs.map((run) => run.jobId)).toEqual([job.id]);
		session.stop();
		const status = await session.done;
		// M07: the job ran in a fresh container, removed after it.
		expect(docker.containers.map((container) => container.removed)).toEqual([
			true,
		]);
		expect(status.finished).toBe(1);
		const nowMs = github.nowMs();
		const [kept] = await registry.list("local");
		expect(kept && machineOnline(kept, nowMs)).toBe(false);
		const choice = chooseMachine(
			await registryMachineCandidates(registry, {
				accountId: "local",
				nowMs,
				readers: new Set(["42"]),
			}),
			{
				labels: ["self-hosted"],
				repository: "octo/app",
				starterId: "42",
				triggeredById: "42",
				preferMachineId: undefined,
				avoidMachineId: undefined,
			},
		);
		expect(choice).toMatchObject({ kind: "none", reason: "no_machine" });
		// M02: no runner stays registered.
		expect(github.runners()).toEqual([]);
	});

	it("drains on the first stop and hands off on the second", async () => {
		const { github, docker, session, label, events, release } = await connected(
			{ hold: true },
		);
		github.queueJob({ repository: "octo/app", name: "build", labels: [label] });
		await until(() => docker.containers.some((found) => found.started));
		session.stop();
		await until(() => events.some((event) => event.type === "worker.draining"));
		session.stop();
		const status = await session.done;
		release();
		expect(status.failed).toBe(1);
		expect(docker.containers[0]?.stopped).toBe(true);
		expect(events.map((event) => event.type)).toEqual(
			expect.arrayContaining([
				"worker.draining",
				"worker.handing_off",
				"machine.disconnected",
			]),
		);
	});

	it("pauses and resumes from the terminal", async () => {
		const { registry, session, events } = await connected();
		await until(() =>
			events.some((event) => event.type === "worker.advertised"),
		);
		expect(await session.togglePause()).toBe(true);
		expect((await registry.list("local"))[0]?.paused).toBe(true);
		expect(await session.togglePause()).toBe(false);
		expect((await registry.list("local"))[0]?.paused).toBe(false);
		session.stop();
		await session.done;
	});
});

describe("the stored machine", () => {
	it("keeps one id and one owner-only key across connects", async () => {
		const { directory, machine, session } = await connected();
		session.stop();
		await session.done;
		expect(machine.created).toBe(true);
		expect(machine.id).toMatch(/^m-[0-9a-f]{12}$/u);
		expect((await stat(join(directory, MACHINE_KEY_FILE))).mode & 0o777).toBe(
			0o600,
		);
		const again = await loadMachine(directory, {
			name: "renamed",
			defaultName: "studio",
		});
		expect(again).toMatchObject({
			id: machine.id,
			name: "renamed",
			created: false,
		});
		expect(again.identity.publicKey).toBe(machine.identity.publicKey);
		expect(await readFile(join(directory, "machine.json"), "utf8")).toContain(
			"renamed",
		);
	});
});

describe("who and what connects", () => {
	it("connects Linux x64 and arm64 machines only", () => {
		expect(machinePlatform("linux", "x64")).toEqual({
			supported: true,
			os: "linux",
			arch: "x64",
		});
		expect(machinePlatform("linux", "arm64")).toMatchObject({ arch: "arm64" });
		expect(machinePlatform("darwin", "arm64")).toMatchObject({
			supported: false,
			reason: expect.stringMatching(/Only Linux/u),
		});
		expect(machinePlatform("linux", "ia32")).toMatchObject({
			supported: false,
			reason: expect.stringMatching(/x64 and arm64/u),
		});
	});

	it("reads the owner from GitHub's signed-in user", async () => {
		const github = {
			request: async (path: string) =>
				path === "/user"
					? Response.json({ id: 42, login: "octocat" })
					: new Response(null, { status: 404 }),
		};
		expect(await githubOwner(github)).toEqual({
			ownerId: "42",
			ownerLogin: "octocat",
		});
		expect(
			await githubOwner({
				request: async () => new Response(null, { status: 401 }),
			}),
		).toBeUndefined();
	});
});
