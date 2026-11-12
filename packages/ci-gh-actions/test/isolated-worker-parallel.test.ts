import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { LeaseSchema } from "@hobo/ci";
import type { SqliteCiStore } from "@hobo/ci/sqlite";
import { describe, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import type { HostedRelayStore } from "../src/hosted-relay.js";
import { createCliDockerDriver } from "../src/isolated-worker/cli-docker-driver.js";
import {
	createIsolatedContainerController,
	RUNNER_EXITED_PATH,
	startRunner,
} from "../src/isolated-worker/container-controller.js";
import type { DockerDriver } from "../src/isolated-worker/docker-driver.js";
import { NOW } from "./fixtures.js";

const lease = (id: string, state: string) =>
	create(LeaseSchema, {
		id,
		accountId: "account-a",
		provider: "kubernetes",
		repository: "org/repo",
		repositoryId: 101,
		installationId: 10,
		jobId: 1,
		originalRunId: 11,
		runAttempt: 1,
		runnerName: `hobo-${id}`,
		state,
		createdAt: NOW,
	});

const RESERVED = "00000000-0000-4000-8000-00000000000a";

function fakeDocker(): DockerDriver & { calls: string[] } {
	const calls: string[] = [];
	let n = 0;
	return {
		calls,
		create: vi.fn(async (spec) => {
			calls.push(`create ${spec.name}`);
			n += 1;
			return { name: spec.name, containerId: `${n}`.padStart(64, "0") };
		}),
		start: vi.fn(async (name: string) => {
			calls.push(`start ${name}`);
		}),
		exec: vi.fn(async () => ({ exitCode: 0 })),
		rename: vi.fn(async (_id: string, name: string) => {
			calls.push(`rename ${name}`);
		}),
		updateResources: vi.fn(async (containerId, weights) => {
			calls.push(
				`update ${weights.cpuShares} ${weights.blkioWeight ?? "off"} ${containerId}`,
			);
		}),
		stop: vi.fn(async () => {}),
		remove: vi.fn(async (name: string) => {
			calls.push(`remove ${name}`);
		}),
		isRunning: vi.fn(async () => true),
	};
}

function controller(
	docker: DockerDriver,
	active: ReturnType<typeof lease>[],
	slots: number,
	container: Readonly<{
		volumes?: readonly Readonly<{ source: string; target: string }>[];
		containerEnv?: Readonly<Record<string, string>>;
		gitMirror?: {
			pathFor(repository: string): string | undefined;
		};
	}> = {},
) {
	const transition = vi.fn(async () => undefined);
	const stub: Pick<
		SqliteCiStore & HostedRelayStore,
		"get" | "activeLeases" | "abortIsolatedAndRequeue"
	> = {
		get: async (id: string) => active.find((entry) => entry.id === id),
		activeLeases: async () => active,
		abortIsolatedAndRequeue: vi.fn(async () => {}),
	};
	const extra = {
		transition,
		policySnapshot: async () => ({ state: undefined, policies: [] }),
	};
	// SAFETY: launch() up to authorization only calls get(), activeLeases(), policySnapshot() and abortIsolatedAndRequeue(); transition() must stay uncalled.
	const store = Object.assign(stub, extra) as SqliteCiStore & HostedRelayStore;
	// SAFETY: no GitHub call happens on the paths under test.
	const github = {} as GithubTransport;
	return {
		transition,
		store,
		ctl: createIsolatedContainerController({
			store,
			github,
			publicOrigin: "https://relay.example",
			docker,
			workerAccountId: "box",
			workerImage: "hobo-ci-worker:local",
			slots,
			...container,
		}),
	};
}

describe("isolated worker parallel slots", () => {
	it("leaves a reserved lease alone while every slot holds a live container", async () => {
		const docker = fakeDocker();
		const active = [
			lease(RESERVED, "reserved"),
			lease("00000000-0000-4000-8000-000000000001", "running"),
			lease("00000000-0000-4000-8000-000000000002", "claiming"),
		];
		const { ctl, transition, store } = controller(docker, active, 2);
		await ctl.host.launch(RESERVED);
		expect(transition).not.toHaveBeenCalled();
		expect(store.abortIsolatedAndRequeue).not.toHaveBeenCalled();
		expect(docker.calls).toEqual([]);
	});

	it("proceeds past the slot gate when a slot is free", async () => {
		const docker = fakeDocker();
		const active = [
			lease(RESERVED, "reserved"),
			lease("00000000-0000-4000-8000-000000000001", "running"),
			lease("00000000-0000-4000-8000-000000000003", "completed"),
		];
		const { ctl, store } = controller(docker, active, 2);
		await ctl.host.launch(RESERVED);
		// Authorization fails in this stub, which proves the gate let it through.
		expect(store.abortIsolatedAndRequeue).toHaveBeenCalledOnce();
	});

	it("rejects nonsense slot counts", () => {
		expect(() => controller(fakeDocker(), [], 0)).toThrow(/slots/);
		expect(() => controller(fakeDocker(), [], 1.5)).toThrow(/slots/);
	});

	it("prewarms one idle container and discards it on shutdown", async () => {
		const docker = fakeDocker();
		const { ctl } = controller(docker, [], 2);
		await Promise.all([ctl.prewarm(), ctl.prewarm()]);
		await ctl.prewarm();
		expect(
			docker.calls.filter((call) => call.startsWith("create")),
		).toHaveLength(1);
		await ctl.discardWarm();
		expect(docker.calls.at(-1)).toMatch(/^remove hobo-warm-/);
	});

	it("mounts the shared store and selects hardlink imports", async () => {
		const docker = fakeDocker();
		const { ctl } = controller(docker, [], 2, {
			volumes: [{ source: "/srv/pnpm-store", target: "/pnpm-store" }],
			containerEnv: {
				npm_config_store_dir: "/pnpm-store",
				npm_config_package_import_method: "hardlink",
			},
		});
		await ctl.prewarm();
		expect(docker.create).toHaveBeenCalledWith(
			expect.objectContaining({
				volumes: [{ source: "/srv/pnpm-store", target: "/pnpm-store" }],
				env: expect.objectContaining({
					npm_config_store_dir: "/pnpm-store",
					npm_config_package_import_method: "hardlink",
				}),
			}),
		);
		await ctl.discardWarm();
	});

	it("mounts an existing box git mirror read-only and names it for checkout", async () => {
		const mirror = mkdtempSync(join(tmpdir(), "hobo-git-mirror-mount-"));
		const docker = fakeDocker();
		const { ctl } = controller(docker, [], 2, {
			gitMirror: { pathFor: () => mirror },
		});
		await ctl.prewarm("Hobo-Labs/HoBo");
		expect(docker.create).toHaveBeenCalledWith(
			expect.objectContaining({
				volumes: [{ source: mirror, target: mirror, readonly: true }],
				env: expect.objectContaining({ HOBO_CI_GIT_MIRROR: mirror }),
			}),
		);
		await ctl.discardWarm();
		rmSync(mirror, { recursive: true, force: true });
	});

	it("exports the container memory limit to the runner environment", async () => {
		const docker = fakeDocker();
		const { ctl } = controller(docker, [], 2);
		await ctl.prewarm();
		expect(docker.create).toHaveBeenCalledWith(
			expect.objectContaining({
				memoryMb: 8192,
				env: expect.objectContaining({
					HOBO_CI_JOB_MEMORY_MB: "8192",
					NODE_OPTIONS: expect.stringMatching(/^--max-old-space-size=\d+$/u),
				}),
			}),
		);
		await ctl.discardWarm();
	});
});

describe("cli docker driver parallel helpers", () => {
	function fakeBinary() {
		const dir = mkdtempSync(join(tmpdir(), "fake-docker-"));
		const log = join(dir, "log");
		const bin = join(dir, "docker");
		writeFileSync(
			bin,
			`#!/bin/sh\necho "$*" >> "${log}"\nprintf '%064d\\n' 7\n`,
		);
		chmodSync(bin, 0o755);
		return { bin, log };
	}

	it("parses image ids, repo tags and labels from docker inspect", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fake-docker-inspect-"));
		try {
			const bin = join(dir, "docker");
			writeFileSync(
				bin,
				`#!/bin/sh\nprintf '%s\\n' '[{"Id":"sha256:abc","RepoTags":["hobo-ci-worker:local","hobo-ci-worker:v0123456789ab"],"Config":{"Labels":{"hobo.ci.toolchain":"v0123456789ab"}}}]'\n`,
			);
			chmodSync(bin, 0o755);
			const driver = createCliDockerDriver({ binary: bin, env: {} });
			await expect(
				driver.inspectImage?.("hobo-ci-worker:local"),
			).resolves.toEqual({
				id: "sha256:abc",
				repoTags: ["hobo-ci-worker:local", "hobo-ci-worker:v0123456789ab"],
				labels: { "hobo.ci.toolchain": "v0123456789ab" },
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("runs image probes as the requested user without network access", async () => {
		const { bin, log } = fakeBinary();
		const driver = createCliDockerDriver({ binary: bin, env: {} });
		await expect(
			driver.probeImage?.(
				"hobo-ci-deps:local",
				["sh", "-c", "test -w /opt/actions-runner/_hobo_work"],
				"1000:1000",
			),
		).resolves.toEqual({ exitCode: 0 });
		expect(readFileSync(log, "utf8").trim()).toBe(
			"run --rm --network none --user 1000:1000 hobo-ci-deps:local sh -c test -w /opt/actions-runner/_hobo_work",
		);
	});

	it("bind-mounts shared volumes and runs the runner detached", async () => {
		const { bin, log } = fakeBinary();
		const driver = createCliDockerDriver({
			binary: bin,
			env: { HOBO_CI_MOUNT_DOCKER_SOCKET: "0", PATH: process.env.PATH },
		});
		await driver.create({
			name: "hobo-x",
			image: "img",
			timeoutMs: 1,
			env: {},
			command: ["sleep", "infinity"],
			volumes: [{ source: "/srv/pnpm-store", target: "/pnpm-store" }],
		});
		await driver.execDetached?.("hobo-x", "c1", ["sh", "-c", "true"]);
		await driver.rename?.("c1", "hobo-y");
		const lines = readFileSync(log, "utf8").trim().split("\n");
		expect(lines[0]).toContain("-v /srv/pnpm-store:/pnpm-store");
		expect(lines[1]).toBe("exec -d c1 sh -c true");
		expect(lines[2]).toBe("rename c1 hobo-y");
	});

	it("gives job containers an init so docker stop does not wait out its timeout", async () => {
		// `sleep infinity` as PID 1 ignores SIGTERM, so every finished lease held
		// its slot for the whole `docker stop -t 30`.
		const { bin, log } = fakeBinary();
		const driver = createCliDockerDriver({
			binary: bin,
			env: { HOBO_CI_MOUNT_DOCKER_SOCKET: "0", PATH: process.env.PATH },
		});
		await driver.create({
			name: "hobo-x",
			image: "img",
			timeoutMs: 1,
			env: {},
			command: ["sleep", "infinity"],
		});
		const argv = readFileSync(log, "utf8").trim().split(" ");
		expect(argv.indexOf("--init")).toBeGreaterThan(0);
		expect(argv.indexOf("--init")).toBeLessThan(argv.indexOf("img"));
	});

	it("passes the per-job memory limit and job memory environment to docker create", async () => {
		const { bin, log } = fakeBinary();
		const driver = createCliDockerDriver({
			binary: bin,
			env: { HOBO_CI_MOUNT_DOCKER_SOCKET: "0", PATH: process.env.PATH },
		});
		await driver.create({
			name: "hobo-x",
			image: "img",
			timeoutMs: 1,
			memoryMb: 3_072,
			env: { HOBO_CI_JOB_MEMORY_MB: "3072" },
			command: ["sleep", "infinity"],
		});
		const argv = readFileSync(log, "utf8").trim();
		expect(argv).toContain("--memory 3072m --memory-swap 3072m");
		expect(argv).toContain("-e HOBO_CI_JOB_MEMORY_MB=3072");
	});

	it("passes ranked CPU and IO weights to create and warm-container updates", async () => {
		const { bin, log } = fakeBinary();
		const driver = createCliDockerDriver({
			binary: bin,
			env: { HOBO_CI_MOUNT_DOCKER_SOCKET: "0", PATH: process.env.PATH },
		});
		await driver.create({
			name: "hobo-trunk",
			image: "img",
			timeoutMs: 1,
			env: {},
			command: ["sleep", "infinity"],
			cpuShares: 8_192,
			blkioWeight: 800,
		});
		await driver.updateResources?.("c1", {
			cpuShares: 512,
			blkioWeight: 200,
		});
		const lines = readFileSync(log, "utf8").trim().split("\n");
		expect(lines[0]).toContain("--cpu-shares 8192 --blkio-weight 800");
		expect(lines[1]).toBe("update --cpu-shares 512 --blkio-weight 200 c1");
	});

	it("falls back to CPU-only weights once the engine rejects block IO weights", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fake-docker-no-blkio-"));
		try {
			const log = join(dir, "log");
			const bin = join(dir, "docker");
			writeFileSync(
				bin,
				`#!/bin/sh\necho "$*" >> "${log}"\ncase " $* " in *" --blkio-weight "*) echo "Block I/O weight is not supported" >&2; exit 125;; esac\nprintf '%064d\\n' 7\n`,
			);
			chmodSync(bin, 0o755);
			const logEvent = vi.fn();
			const driver = createCliDockerDriver({
				binary: bin,
				env: { HOBO_CI_MOUNT_DOCKER_SOCKET: "0", PATH: process.env.PATH },
				log: logEvent,
			});
			const spec = {
				name: "hobo-x",
				image: "img",
				timeoutMs: 1,
				env: {},
				command: ["sleep", "infinity"],
				cpuShares: 8_192,
				blkioWeight: 800,
			} as const;
			await driver.create(spec);
			await driver.create({ ...spec, name: "hobo-y" });
			await driver.updateResources?.("c1", {
				cpuShares: 512,
				blkioWeight: 200,
			});
			const lines = readFileSync(log, "utf8").trim().split("\n");
			expect(lines).toHaveLength(4);
			expect(lines[0]).toContain("--blkio-weight 800");
			expect(lines.slice(1).join("\n")).not.toContain("--blkio-weight");
			expect(lines[1]).toContain("--cpu-shares 8192");
			expect(lines[3]).toBe("update --cpu-shares 512 c1");
			expect(logEvent).toHaveBeenCalledOnce();
			expect(logEvent).toHaveBeenCalledWith(
				"hobo_ci_blkio_weight_unsupported",
				expect.objectContaining({
					message: expect.stringContaining("Block I/O weight"),
				}),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each([
		{ cpuShares: 1, blkioWeight: 800 },
		{ cpuShares: 512, blkioWeight: 9 },
	])("rejects invalid container resource weights %o", async (weights) => {
		const { bin } = fakeBinary();
		const driver = createCliDockerDriver({
			binary: bin,
			env: { HOBO_CI_MOUNT_DOCKER_SOCKET: "0" },
		});
		await expect(
			driver.create({
				name: "hobo-x",
				image: "img",
				timeoutMs: 1,
				env: {},
				command: [],
				...weights,
			}),
		).rejects.toThrow(/invalid container/u);
	});

	it("appends :ro only from the typed readonly flag", async () => {
		const { bin, log } = fakeBinary();
		const driver = createCliDockerDriver({
			binary: bin,
			env: { HOBO_CI_MOUNT_DOCKER_SOCKET: "0" },
		});
		await driver.create({
			name: "hobo-x",
			image: "img",
			timeoutMs: 1,
			env: {},
			command: [],
			volumes: [
				{
					source: "/var/lib/hobo-ci/git/Hobo-Labs/HoBo.git",
					target: "/var/lib/hobo-ci/git/Hobo-Labs/HoBo.git",
					readonly: true,
				},
			],
		});
		expect(readFileSync(log, "utf8")).toContain(
			"-v /var/lib/hobo-ci/git/Hobo-Labs/HoBo.git:/var/lib/hobo-ci/git/Hobo-Labs/HoBo.git:ro",
		);
	});

	it("refuses volume specs that could smuggle extra mount options", async () => {
		const { bin } = fakeBinary();
		const driver = createCliDockerDriver({
			binary: bin,
			env: { HOBO_CI_MOUNT_DOCKER_SOCKET: "0" },
		});
		await expect(
			driver.create({
				name: "hobo-x",
				image: "img",
				timeoutMs: 1,
				env: {},
				command: [],
				volumes: [{ source: "/a:/etc", target: "/b" }],
			}),
		).rejects.toThrow(/volume/);
	});

	it("never puts the runner JIT config in any docker argv", async () => {
		const jit = "fake-jit-credential-value";
		const b64 = Buffer.from(jit, "utf8").toString("base64");
		const argvs: string[][] = [];
		const written: string[] = [];
		const docker = fakeDocker();
		docker.execDetached = vi.fn(async (_n, _c, argv) => {
			argvs.push([...argv]);
			return { exitCode: 0 };
		});
		docker.writeSecret = vi.fn(async (_n, _c, _path, content) => {
			written.push(content);
		});
		await startRunner(docker, "hobo-x", "c1", jit);
		expect(written).toEqual([jit]);
		const flat = argvs.flat().join("\n");
		expect(flat).not.toContain(jit);
		expect(flat).not.toContain(b64);
		expect(flat).not.toContain("--jitconfig");
		expect(flat).toContain("ACTIONS_RUNNER_INPUT_JITCONFIG");
		expect(flat).toContain("set -eu\numask 022\n");
	});

	it("refuses to start a runner when the driver cannot deliver secrets", async () => {
		const docker = fakeDocker();
		await expect(startRunner(docker, "hobo-x", "c1", "x")).rejects.toThrow(
			/secrets/,
		);
		expect(docker.exec).not.toHaveBeenCalled();
	});

	it("CLI driver writes secrets through stdin, not argv", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-docker-"));
		const bin = join(dir, "docker");
		writeFileSync(
			bin,
			`#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\ncat > "${dir}/stdin"\n`,
		);
		chmodSync(bin, 0o755);
		const driver = createCliDockerDriver({ binary: bin, env: {} });
		await driver.writeSecret?.(
			"hobo-x",
			"c1",
			"/tmp/hobo-ci-jit",
			"s3cr3t-jit",
		);
		expect(readFileSync(join(dir, "stdin"), "utf8")).toBe("s3cr3t-jit");
		expect(readFileSync(join(dir, "argv"), "utf8")).not.toContain("s3cr3t-jit");
	});

	it("writes the exit marker after the runner exits, whatever its status", async () => {
		const argvs: string[][] = [];
		const docker = fakeDocker();
		docker.writeSecret = vi.fn(async () => undefined);
		docker.execDetached = vi.fn(async (_n, _c, argv) => {
			argvs.push([...argv]);
			return { exitCode: 0 };
		});
		await startRunner(docker, "hobo-x", "c1", "jit");
		const script = argvs[0]?.at(-1) ?? "";
		const dir = mkdtempSync(join(tmpdir(), "hobo-runner-"));
		try {
			for (const status of [0, 3]) {
				const runner = join(dir, `runner-${status}`);
				mkdirSync(runner);
				writeFileSync(join(runner, "run.sh"), `#!/bin/sh\nexit ${status}\n`);
				chmodSync(join(runner, "run.sh"), 0o755);
				const marker = join(dir, `exited-${status}`);
				const local = script
					.replaceAll("/opt/actions-runner", runner)
					.replaceAll(RUNNER_EXITED_PATH, marker)
					.replaceAll("/tmp/hobo-ci-jit", join(dir, "jit"));
				writeFileSync(join(dir, "jit"), "jit");
				execFileSync("sh", ["-ec", local]);
				expect(existsSync(marker)).toBe(true);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("CLI driver reports a path's existence and rejects when docker fails", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-docker-"));
		try {
			const bin = join(dir, "docker");
			// Fake docker: `exec <id> test -e <path>`; container "gone" fails like docker (125).
			writeFileSync(
				bin,
				`#!/bin/sh\n[ "$2" = gone ] && exit 125\nshift 2\nexec "$@"\n`,
			);
			chmodSync(bin, 0o755);
			const driver = createCliDockerDriver({ binary: bin, env: {} });
			writeFileSync(join(dir, "present"), "");
			await expect(
				driver.exists?.("hobo-x", "c1", join(dir, "present")),
			).resolves.toBe(true);
			await expect(
				driver.exists?.("hobo-x", "c1", join(dir, "absent")),
			).resolves.toBe(false);
			await expect(
				driver.exists?.("hobo-x", "gone", join(dir, "present")),
			).rejects.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
