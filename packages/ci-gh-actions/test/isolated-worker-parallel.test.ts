import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { LeaseSchema } from "@hobo/ci";
import type { PostgresCiStore } from "@hobo/ci/postgres";
import { describe, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import type { HostedRelayStore } from "../src/hosted-relay.js";
import { createCliDockerDriver } from "../src/isolated-worker/cli-docker-driver.js";
import {
	createIsolatedContainerController,
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
) {
	const transition = vi.fn(async () => undefined);
	const stub: Pick<
		PostgresCiStore & HostedRelayStore,
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
	const store = Object.assign(stub, extra) as PostgresCiStore &
		HostedRelayStore;
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
});
