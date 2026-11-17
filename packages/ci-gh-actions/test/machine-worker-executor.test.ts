import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	RUNNER_SHA256,
	RUNNER_SHA256_ARM64,
	RUNNER_URL,
	RUNNER_URL_ARM64,
	RUNNER_VERSION,
} from "../src/bootstrap.js";
import {
	containerJobEnvironment,
	hostExecutor,
	hostJobEnvironment,
	pinnedRunnerProgram,
	RUNNER_JIT_CONFIG_ENV,
	type RunnerProgram,
} from "../src/machine-worker/executor.js";
import { fakeHostProcess } from "../src/machine-worker/testing.js";

const CLI_ENV = {
	PATH: "/usr/bin",
	HOME: "/home/octocat",
	GH_TOKEN: "gho_cli",
	GITHUB_TOKEN: "ghs_cli",
	HOBO_CI_ACCOUNT_ID: "acct-1",
	HOBO_CI_CONTROL_TOKEN: "control",
	AWS_SECRET_ACCESS_KEY: "aws",
	HTTPS_PROXY: "http://proxy:3128",
} satisfies NodeJS.ProcessEnv;

const SECRET_NAMES = [
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"HOBO_CI_ACCOUNT_ID",
	"HOBO_CI_CONTROL_TOKEN",
	"AWS_SECRET_ACCESS_KEY",
];

let scratch: string | undefined;
afterEach(async () => {
	if (scratch) await rm(scratch, { recursive: true, force: true });
	scratch = undefined;
});

describe("a machine job's environment", () => {
	it("gives a container the pinned runner for its architecture and the proxy, nothing else", () => {
		const x64 = containerJobEnvironment(CLI_ENV, "x64");
		expect(Object.fromEntries(x64)).toEqual({
			HOBO_CI_RUNNER_URL: RUNNER_URL,
			HOBO_CI_RUNNER_SHA256: RUNNER_SHA256,
			HTTPS_PROXY: "http://proxy:3128",
		});
		const arm64 = containerJobEnvironment({}, "arm64");
		expect(arm64.get("HOBO_CI_RUNNER_URL")).toBe(RUNNER_URL_ARM64);
		expect(arm64.get("HOBO_CI_RUNNER_SHA256")).toBe(RUNNER_SHA256_ARM64);
	});

	it("gives a host job the bridge's allow-list and the configuration, never the CLI's tokens", () => {
		const env = hostJobEnvironment(CLI_ENV, "ZW5jb2RlZA==");
		for (const name of SECRET_NAMES) expect(env[name]).toBeUndefined();
		expect(env[RUNNER_JIT_CONFIG_ENV]).toBe("ZW5jb2RlZA==");
		expect(env.PATH).toBe("/usr/bin");
	});
});

describe("the host executor", () => {
	it("runs the runner program in a fresh copy, with the configuration in its environment, and removes the copy", async () => {
		const prepared: string[] = [];
		const discarded: string[] = [];
		const program: RunnerProgram = {
			async prepare() {
				const directory = `/work/job-${prepared.length + 1}`;
				prepared.push(directory);
				return directory;
			},
			async discard(directory) {
				discarded.push(directory);
			},
		};
		const seen: string[] = [];
		const host = fakeHostProcess(async (start) => {
			seen.push(start.encodedJitConfig);
			return 0;
		});
		const executor = hostExecutor({
			program,
			process: host.process,
			env: CLI_ENV,
		});
		expect(executor.isolation).toBe("host");
		const outcome = await executor.run({
			name: "hobo-machine-m-1-7",
			encodedJitConfig: "Y29uZmln",
			signal: new AbortController().signal,
		});
		expect(outcome).toEqual({ exitCode: 0, stopped: false });
		expect(seen).toEqual(["Y29uZmln"]);
		expect(host.calls).toHaveLength(1);
		const call = host.calls[0];
		expect(call?.command).toBe("/work/job-1/run.sh");
		expect(call?.args).toEqual([]);
		for (const name of SECRET_NAMES) expect(call?.env[name]).toBeUndefined();
		expect(discarded).toEqual(["/work/job-1"]);
	});
});

describe("the pinned runner program", () => {
	it("downloads the pinned archive and refuses one whose checksum does not match", async () => {
		scratch = await mkdtemp(join(tmpdir(), "hobo-machine-runner-"));
		const asked: string[] = [];
		const host = fakeHostProcess(async () => 0);
		const program = pinnedRunnerProgram({
			fetch: async (input) => {
				asked.push(String(input));
				return new Response("not the runner");
			},
			cacheDir: scratch,
			arch: "arm64",
			process: host.process,
			env: CLI_ENV,
		});
		await expect(program.prepare(new AbortController().signal)).rejects.toThrow(
			/does not match its pinned checksum/u,
		);
		expect(asked).toEqual([RUNNER_URL_ARM64]);
		expect(host.calls).toEqual([]);
		expect(await readdir(scratch)).toEqual([]);
	});

	it("fetches again when the cached archive no longer matches", async () => {
		scratch = await mkdtemp(join(tmpdir(), "hobo-machine-runner-"));
		await writeFile(
			join(scratch, `actions-runner-x64-${RUNNER_VERSION}.tar.gz`),
			"tampered",
		);
		const asked: string[] = [];
		const program = pinnedRunnerProgram({
			fetch: async (input) => {
				asked.push(String(input));
				return new Response("still not the runner");
			},
			cacheDir: scratch,
			arch: "x64",
			process: fakeHostProcess(async () => 0).process,
			env: {},
		});
		await expect(program.prepare(new AbortController().signal)).rejects.toThrow(
			/checksum/u,
		);
		expect(asked).toEqual([RUNNER_URL]);
	});
});
