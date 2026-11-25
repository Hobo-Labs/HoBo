import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateMachineIdentity } from "@hobo/ci";
import { InMemoryMachineRegistry } from "@hobo/ci/runner-order/testing";
import { afterEach, describe, expect, it } from "vitest";
import { RUNNER_VERSION } from "../src/bootstrap.js";
import {
	machineRunsOnLabel,
	registryAdvertSink,
} from "../src/machine-worker/advert.js";
import { hostExecutor } from "../src/machine-worker/executor.js";
import { githubQueueJobSource } from "../src/machine-worker/jobs.js";
import {
	APPLE_CONTAINER_TOOL,
	appleContainerExecutor,
	appleContainerStatus,
	MACOS_RUNNER_SHA256,
	MACOS_RUNNER_SHA256_ARM64,
	machineConnectPlan,
	macosRunnerDownloadFor,
	pinnedMacosRunnerProgram,
} from "../src/machine-worker/macos/index.js";
import { FakeAppleContainerTool } from "../src/machine-worker/macos/testing.js";
import { fakeHostProcess } from "../src/machine-worker/testing.js";
import { createMachineWorker } from "../src/machine-worker/worker.js";
import { GithubSimulator } from "./support/github-simulator/index.js";
import {
	simulatedRunnerProgram,
	simulatorMachineGithub,
} from "./support/machine-connect-simulator.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const AVAILABLE = { available: true } as const;

describe("the pinned macOS runner archives", () => {
	it("name one runner version and a SHA-256 for each architecture", () => {
		const arm = macosRunnerDownloadFor("arm64");
		const intel = macosRunnerDownloadFor("x64");
		expect(arm.url).toBe(
			`https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-osx-arm64-${RUNNER_VERSION}.tar.gz`,
		);
		expect(intel.url).toBe(
			`https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-osx-x64-${RUNNER_VERSION}.tar.gz`,
		);
		expect(arm.sha256).toBe(MACOS_RUNNER_SHA256_ARM64);
		expect(intel.sha256).toBe(MACOS_RUNNER_SHA256);
		for (const download of [arm, intel])
			expect(download.sha256).toMatch(/^[0-9a-f]{64}$/u);
		expect(arm.sha256).not.toBe(intel.sha256);
	});
});

describe("how a machine connects on each platform", () => {
	it("keeps Linux as it was: a container by default, the host with --host", () => {
		expect(
			machineConnectPlan(
				{ platform: "linux", arch: "x64" },
				{ host: false, vm: false },
				undefined,
			),
		).toEqual({
			ok: true,
			mode: "container",
			os: "linux",
			arch: "x64",
			isolation: "container",
		});
		expect(
			machineConnectPlan(
				{ platform: "linux", arch: "arm64" },
				{ host: true, vm: false },
				undefined,
			),
		).toMatchObject({ ok: true, mode: "host", isolation: "host" });
	});

	it("asks a Mac for --host, because there is no container default", () => {
		const plan = machineConnectPlan(
			{ platform: "darwin", arch: "arm64" },
			{ host: false, vm: false },
			undefined,
		);
		expect(plan.ok).toBe(false);
		expect(plan.ok ? "" : plan.reason).toMatch(/--host/u);
		expect(plan.ok ? "" : plan.reason).toMatch(/--vm/u);
	});

	it("runs a Mac's jobs on the host with --host, with macOS labels", () => {
		for (const arch of ["arm64", "x64"] as const)
			expect(
				machineConnectPlan(
					{ platform: "darwin", arch },
					{ host: true, vm: false },
					undefined,
				),
			).toEqual({
				ok: true,
				mode: "host",
				os: "macos",
				arch,
				isolation: "host",
			});
	});

	it("runs each job in its own Linux VM with --vm when Apple's container tool is there", () => {
		expect(
			machineConnectPlan(
				{ platform: "darwin", arch: "arm64" },
				{ host: false, vm: true },
				AVAILABLE,
			),
		).toEqual({
			ok: true,
			mode: "vm",
			os: "linux",
			arch: "arm64",
			isolation: "container",
		});
	});

	it("refuses --vm it cannot honour and never falls back to the host", () => {
		const missing = machineConnectPlan(
			{ platform: "darwin", arch: "arm64" },
			{ host: false, vm: true },
			{ available: false, reason: "Apple's container tool is not installed." },
		);
		expect(missing).toEqual({
			ok: false,
			reason: expect.stringContaining("not installed"),
		});
		const unprobed = machineConnectPlan(
			{ platform: "darwin", arch: "arm64" },
			{ host: false, vm: true },
			undefined,
		);
		expect(unprobed.ok).toBe(false);
		const intel = machineConnectPlan(
			{ platform: "darwin", arch: "x64" },
			{ host: false, vm: true },
			AVAILABLE,
		);
		expect(intel.ok ? "" : intel.reason).toMatch(/Apple silicon/u);
		const linux = machineConnectPlan(
			{ platform: "linux", arch: "arm64" },
			{ host: false, vm: true },
			AVAILABLE,
		);
		expect(linux.ok).toBe(false);
		const both = machineConnectPlan(
			{ platform: "darwin", arch: "arm64" },
			{ host: true, vm: true },
			AVAILABLE,
		);
		expect(both.ok ? "" : both.reason).toMatch(/not both/u);
	});

	it("refuses other systems and architectures", () => {
		expect(
			machineConnectPlan(
				{ platform: "win32", arch: "x64" },
				{ host: true, vm: false },
				undefined,
			).ok,
		).toBe(false);
		expect(
			machineConnectPlan(
				{ platform: "darwin", arch: "ia32" },
				{ host: true, vm: false },
				undefined,
			).ok,
		).toBe(false);
	});
});

describe("Apple's container tool", () => {
	it("is available when its services answer, and says why when not", async () => {
		const tool = new FakeAppleContainerTool(async () => 0);
		expect(await appleContainerStatus(tool.process)).toEqual({
			available: true,
		});
		tool.servicesRunning = false;
		const stopped = await appleContainerStatus(tool.process);
		expect(stopped.available).toBe(false);
		expect(stopped.available ? "" : stopped.reason).toMatch(
			/container system start/u,
		);
		const absent = await appleContainerStatus(async () => {
			throw Object.assign(new Error("spawn container ENOENT"), {
				code: "ENOENT",
			});
		});
		expect(absent.available ? "" : absent.reason).toMatch(/not installed/u);
		expect(tool.calls[0]?.command).toBe(APPLE_CONTAINER_TOOL);
	});
});

describe("a macOS machine", () => {
	const directories: string[] = [];
	afterEach(async () => {
		for (const directory of directories.splice(0))
			await rm(directory, { recursive: true, force: true });
	});

	function machine(
		options: Readonly<{
			os: "macos" | "linux";
			arch: "arm64" | "x64";
			isolation: "host" | "container";
		}>,
	) {
		const github = new GithubSimulator();
		github.addRepository("octo/app", true);
		const registry = new InMemoryMachineRegistry();
		const id = "m-mac0";
		const machineGithub = simulatorMachineGithub(github);
		const { program, runs } = simulatedRunnerProgram(github);
		return {
			github,
			registry,
			runs,
			program,
			label: machineRunsOnLabel(id),
			worker: (
				executor: Parameters<typeof createMachineWorker>[0]["executor"],
			) =>
				createMachineWorker({
					profile: {
						id,
						name: "studio-mac",
						os: options.os,
						arch: options.arch,
						accountId: "local",
						ownerId: "42",
						ownerLogin: "octocat",
						isolation: options.isolation,
					},
					identity: generateMachineIdentity().identity,
					sink: registryAdvertSink(registry, {
						accountId: "local",
						ownerId: "42",
						ownerLogin: "octocat",
					}),
					jobs: githubQueueJobSource({
						github: machineGithub,
						repositories: ["octo/app"],
						label: machineRunsOnLabel(id),
						pollMs: 0,
					}),
					github: machineGithub,
					executor,
					concurrency: 1,
					sharing: "only_me",
					now: () => github.nowMs(),
					emit: () => {},
				}),
		};
	}

	it("runs a job on the host from the pinned macOS archive, and its advert says host", async () => {
		const setup = machine({ os: "macos", arch: "arm64", isolation: "host" });
		const cacheDir = await mkdtemp(join(tmpdir(), "hobo-macos-"));
		directories.push(cacheDir);
		const archive = new TextEncoder().encode("macos runner archive");
		const download = {
			url: "https://example.test/actions-runner-osx-arm64.tar.gz",
			sha256: createHash("sha256").update(archive).digest("hex"),
		};
		const fetched: string[] = [];
		const host = fakeHostProcess(setup.program);
		const env = {
			PATH: "/usr/bin:/bin",
			HOME: "/Users/octocat",
			GH_TOKEN: "gho_secret",
			GITHUB_TOKEN: "ghs_secret",
		};
		const worker = setup.worker(
			hostExecutor({
				program: pinnedMacosRunnerProgram({
					fetch: async (url) => {
						fetched.push(String(url));
						return new Response(archive);
					},
					cacheDir,
					arch: "arm64",
					process: host.process,
					env,
					download,
				}),
				process: host.process,
				env,
			}),
		);
		const job = setup.github.queueJob({
			repository: "octo/app",
			name: "test-ios",
			labels: [setup.label],
		});
		await worker.tick();
		for (let turn = 0; turn < 400 && worker.status().running > 0; turn++)
			await new Promise((resolve) => setTimeout(resolve, 5));

		const [advert] = await setup.registry.list("local");
		expect(advert).toMatchObject({
			os: "macos",
			arch: "arm64",
			isolation: "host",
			labels: ["self-hosted", "macOS", "ARM64"],
		});
		expect(setup.runs.map((run) => run.jobId)).toEqual([job.id]);
		expect(
			setup.github.jobs().find((found) => found.id === job.id)?.conclusion,
		).toBe("success");
		expect(fetched).toEqual([download.url]);
		const unpack = host.calls.find((call) => call.command === "tar");
		expect(unpack?.args[1]).toContain(
			`actions-runner-osx-arm64-${RUNNER_VERSION}`,
		);
		const run = host.calls.find((call) => call.command.endsWith("run.sh"));
		expect(
			Object.keys(run?.env ?? {}).filter((name) => /TOKEN/u.test(name)),
		).toEqual([]);
		expect(run?.env.HOME).toBe("/Users/octocat");
		expect(
			(await readdir(cacheDir)).filter((name) => name.startsWith("job-")),
		).toEqual([]);
	});

	it("refuses a macOS archive that does not match its checksum", async () => {
		const cacheDir = await mkdtemp(join(tmpdir(), "hobo-macos-"));
		directories.push(cacheDir);
		const host = fakeHostProcess(async () => 0);
		const program = pinnedMacosRunnerProgram({
			fetch: async () => new Response("tampered"),
			cacheDir,
			arch: "x64",
			process: host.process,
			env: {},
			download: {
				url: "https://example.test/x.tar.gz",
				sha256: "0".repeat(64),
			},
		});
		await expect(program.prepare(new AbortController().signal)).rejects.toThrow(
			/checksum/u,
		);
		expect(host.calls).toEqual([]);
	});

	it("fetches a cached archive again when it no longer matches", async () => {
		const cacheDir = await mkdtemp(join(tmpdir(), "hobo-macos-"));
		directories.push(cacheDir);
		const good = new TextEncoder().encode("good");
		const download = {
			url: "https://example.test/x.tar.gz",
			sha256: createHash("sha256").update(good).digest("hex"),
		};
		await writeFile(
			join(cacheDir, `actions-runner-osx-x64-${RUNNER_VERSION}.tar.gz`),
			"stale",
		);
		let fetches = 0;
		const host = fakeHostProcess(async () => 0);
		const program = pinnedMacosRunnerProgram({
			fetch: async () => {
				fetches += 1;
				return new Response(good);
			},
			cacheDir,
			arch: "x64",
			process: host.process,
			env: {},
			download,
		});
		const first = await program.prepare(new AbortController().signal);
		await program.discard(first);
		const second = await program.prepare(new AbortController().signal);
		await program.discard(second);
		expect(fetches).toBe(1);
	});

	it("with --vm runs each job in its own Linux VM and removes it after", async () => {
		const setup = machine({
			os: "linux",
			arch: "arm64",
			isolation: "container",
		});
		const tool = new FakeAppleContainerTool(setup.program);
		const worker = setup.worker(
			appleContainerExecutor({
				process: tool.process,
				image: "runner:test",
				env: { GH_TOKEN: "gho_secret", HTTPS_PROXY: "http://proxy:3128" },
				wait: () => tick(),
			}),
		);
		const first = setup.github.queueJob({
			repository: "octo/app",
			name: "build",
			labels: [setup.label],
		});
		await worker.tick();
		for (let turn = 0; turn < 500 && worker.status().running > 0; turn++)
			await tick();
		const second = setup.github.queueJob({
			repository: "octo/app",
			name: "build",
			labels: [setup.label],
		});
		await worker.tick();
		for (let turn = 0; turn < 500 && worker.status().running > 0; turn++)
			await tick();

		expect(setup.runs.map((run) => run.jobId)).toEqual([first.id, second.id]);
		expect(tool.vms).toHaveLength(2);
		for (const vm of tool.vms) {
			expect(vm.image).toBe("runner:test");
			expect(vm.started).toBe(true);
			expect(vm.deleted).toBe(true);
			expect(vm.env.get("HOBO_CI_RUNNER_URL")).toContain("linux-arm64");
			expect(vm.env.get("HTTPS_PROXY")).toBe("http://proxy:3128");
			expect([...vm.env.keys()].filter((name) => /TOKEN/u.test(name))).toEqual(
				[],
			);
		}
		const [advert] = await setup.registry.list("local");
		expect(advert).toMatchObject({
			isolation: "container",
			labels: ["self-hosted", "Linux", "ARM64"],
		});
		const secrets = tool.vms.flatMap((vm) => [...vm.secrets.values()]);
		expect(secrets).toHaveLength(2);
		for (const call of tool.calls)
			for (const secret of secrets) expect(call.args).not.toContain(secret);
	});
});
