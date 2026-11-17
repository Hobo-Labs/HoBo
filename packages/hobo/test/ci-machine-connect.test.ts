import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machineOnline } from "@hobo/ci";
import { InMemoryMachineRegistry } from "@hobo/ci/runner-order/testing";
import {
	type JobExecutor,
	type MachineGithub,
	type MachineSession,
	parseWorkerEvent,
} from "@hobo/ci-gh-actions/machine-worker";
import { createHoboCli } from "@hobo/cli";
import { afterEach, describe, expect, it } from "vitest";
import { createCiCommand } from "../src/ci-command.js";
import { CI_COMMANDS, findCiCommand } from "../src/ci-commands.js";
import { createCiMachineCommand } from "../src/ci-machine.js";
import {
	CI_MACHINE_CONNECT_COMMAND,
	type CiMachineConnectDeps,
	createCiMachineConnectCommand,
	defaultGithubToken,
	type MachineExecutorChoice,
} from "../src/ci-machine-connect.js";

const NOW = 1_763_337_600_000;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

/** GitHub as a signed-in owner whose repository has no queued job. */
function quietGithub(requests: string[], user = true): MachineGithub {
	return {
		async request(path) {
			requests.push(path);
			if (path === "/user")
				return user
					? Response.json({ id: 42, login: "octocat" })
					: new Response(null, { status: 401 });
			if (path === "/repos/octo/app") return Response.json({ private: true });
			if (path.includes("/actions/runs?"))
				return Response.json({ workflow_runs: [] });
			return new Response(null, { status: 404 });
		},
	};
}

const neverRuns: JobExecutor = {
	isolation: "container",
	run: async () => {
		throw new Error("no job is queued");
	},
};

type Harness = Readonly<{
	run: (args: readonly string[]) => Promise<{
		exitCode: number;
		stdout: string;
		stderr: string;
	}>;
	registry: InMemoryMachineRegistry;
	lines: string[];
	requests: string[];
	choices: MachineExecutorChoice[];
	tokensAsked: NodeJS.ProcessEnv[];
}>;

async function harness(
	options: Readonly<{
		token?: string | undefined;
		user?: boolean;
		platform?: Readonly<{ platform: string; arch: string }>;
		/** What happens once the session is running; it is stopped by default. */
		drive?: (session: MachineSession) => Promise<void>;
	}> = {},
): Promise<Harness> {
	const home = await mkdtemp(join(tmpdir(), "hobo-connect-"));
	directories.push(home);
	const registry = new InMemoryMachineRegistry();
	const lines: string[] = [];
	const requests: string[] = [];
	const choices: MachineExecutorChoice[] = [];
	const tokensAsked: NodeJS.ProcessEnv[] = [];
	const deps: CiMachineConnectDeps = {
		githubToken: async (env) => {
			tokensAsked.push(env);
			return "token" in options ? options.token : "gho_owner";
		},
		github: () => quietGithub(requests, options.user ?? true),
		openRegistry: async () => ({
			registry,
			where: "memory",
			close: () => {},
		}),
		executor: (choice) => {
			choices.push(choice);
			return { ...neverRuns, isolation: choice.host ? "host" : "container" };
		},
		platform: options.platform ?? { platform: "linux", arch: "x64" },
		hostname: () => "studio",
		controls: (session) => {
			void (async () => {
				for (let turn = 0; turn < 50; turn++) await tick();
				if (options.drive) await options.drive(session);
				session.stop();
			})();
			return () => {};
		},
		writeLine: (line) => lines.push(line),
		wait: () => tick(),
		machine: createCiMachineCommand({
			openRegistry: async () => ({
				registry,
				where: "memory",
				close: () => {},
			}),
		}),
	};
	const cli = createHoboCli({
		commands: {
			ci: createCiCommand({
				env: { HOBO_HOME: home, GH_TOKEN: "gho_owner" },
				now: () => NOW,
				commands: [createCiMachineConnectCommand(deps)],
			}),
		},
	});
	return {
		run: (args) => cli.run(["ci", "machine", ...args], { cwd: tmpdir() }),
		registry,
		lines,
		requests,
		choices,
		tokensAsked,
	};
}

describe("hobo ci machine connect", () => {
	it("M01: connects with one command, advertises a container machine, and goes offline on Ctrl-C", async () => {
		const { run, registry, choices } = await harness();
		const result = await run(["connect", "--repo", "octo/app", "--json"]);
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout);
		expect(envelope.data).toMatchObject({
			name: "studio",
			account: "local",
			isolation: "container",
			finished: 0,
			refused: null,
		});
		expect(envelope.data.runsOn).toBe(`hobo-machine-${envelope.data.machine}`);
		const [machine] = await registry.list("local");
		expect(machine).toMatchObject({
			name: "studio",
			isolation: "container",
			ownerId: "42",
			ownerLogin: "octocat",
			sharing: "only_me",
			slots: 1,
		});
		expect(machine && machineOnline(machine, NOW)).toBe(false);
		expect(choices).toMatchObject([
			{
				host: false,
				arch: "x64",
				image: expect.stringMatching(/actions-runner/u),
			},
		]);
	});

	it("keeps the machine's id across connects", async () => {
		const first = await harness();
		const one = JSON.parse(
			(await first.run(["connect", "--repo", "octo/app", "--json"])).stdout,
		);
		const two = JSON.parse(
			(await first.run(["connect", "--repo", "octo/app", "--json"])).stdout,
		);
		expect(two.data.machine).toBe(one.data.machine);
	});

	it("M07: says so in the advert when jobs run on the host", async () => {
		const { run, registry, choices } = await harness();
		const result = await run([
			"connect",
			"--repo",
			"octo/app",
			"--host",
			"--concurrency",
			"3",
			"--share",
			"anyone",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("its jobs ran on this machine's host");
		expect(await registry.list("local")).toMatchObject([
			{ isolation: "host", slots: 3, sharing: "anyone" },
		]);
		expect(choices[0]?.host).toBe(true);
	});

	it("prints one JSON object per line with --events", async () => {
		const { run, lines } = await harness();
		await run(["connect", "--repo", "octo/app", "--events"]);
		const types = lines.map((line) => JSON.parse(line).type);
		expect(types[0]).toBe("machine.connected");
		expect(types).toContain("worker.advertised");
		expect(types.slice(-2)).toEqual([
			"worker.draining",
			"machine.disconnected",
		]);
		// Each worker line is a WorkerEvent record (machine_worker.proto).
		const worker = lines.filter((line) => line.includes('"worker.'));
		expect(worker.length).toBeGreaterThan(0);
		for (const line of worker)
			expect(parseWorkerEvent(line).type).toMatch(/^worker\./u);
	});

	it("pauses from the terminal and the registry keeps it", async () => {
		const { run, registry } = await harness({
			drive: async (session) => {
				await session.togglePause();
			},
		});
		await run(["connect", "--repo", "octo/app"]);
		expect((await registry.list("local"))[0]?.paused).toBe(true);
	});

	it("reads only the named repositories' queues, as the owner", async () => {
		const { run, requests } = await harness();
		await run(["connect", "--repo", "octo/app"]);
		expect(requests[0]).toBe("/user");
		expect(
			requests.every(
				(path) => path === "/user" || path.startsWith("/repos/octo/app"),
			),
		).toBe(true);
	});

	it("asks for a sign-in when there is no GitHub token, or GitHub refuses it", async () => {
		const none = await harness({ token: undefined });
		const missing = await none.run(["connect", "--repo", "octo/app", "--json"]);
		expect(missing.exitCode).not.toBe(0);
		expect(JSON.parse(missing.stdout)).toMatchObject({
			ok: false,
			code: "HOBO_CI_MACHINE_SIGN_IN",
		});
		const refused = await harness({ user: false });
		const result = await refused.run([
			"connect",
			"--repo",
			"octo/app",
			"--json",
		]);
		expect(JSON.parse(result.stdout).message).toMatch(/did not accept/u);
		expect(await refused.registry.list("local")).toEqual([]);
	});

	it("reads the gh sign-in on a clean machine, before HOBO_HOME exists", async () => {
		const missing = join(tmpdir(), `hobo-home-missing-${process.pid}`);
		expect(existsSync(missing)).toBe(false);
		const calls: string[] = [];
		const token = await defaultGithubToken(
			{ HOBO_HOME: missing, HOME: missing },
			async (file, args, options) => {
				calls.push([file, ...args].join(" "));
				// As execFile does: a working directory that does not exist fails.
				if (!existsSync(options.cwd))
					throw new Error(`spawn ${file} ENOENT (cwd ${options.cwd})`);
				return { stdout: "gho_signed_in\n", stderr: "" };
			},
		);
		expect(token).toBe("gho_signed_in");
		expect(calls).toEqual(["gh auth token"]);
		expect(
			await defaultGithubToken({ GH_TOKEN: "gho_named" }, async () => {
				throw new Error("gh is not asked when a token is named");
			}),
		).toBe("gho_named");
	});

	it("connects Linux machines only, for now", async () => {
		const { run } = await harness({
			platform: { platform: "darwin", arch: "arm64" },
		});
		const result = await run(["connect", "--repo", "octo/app", "--json"]);
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: false,
			code: "HOBO_CI_MACHINE_UNSUPPORTED",
		});
	});

	it("refuses arguments it cannot use", async () => {
		const { run, tokensAsked } = await harness();
		for (const args of [
			["connect"],
			["connect", "--repo", "not-a-repo"],
			["connect", "--repo", "octo/app", "--concurrency", "0"],
			["connect", "--repo", "octo/app", "--share", "everyone"],
			["connect", "--repo", "octo/app", "extra"],
		]) {
			const result = await run([...args, "--json"]);
			expect(JSON.parse(result.stdout)).toMatchObject({
				ok: false,
				code: "HOBO_CI_MACHINE_USAGE",
			});
		}
		expect(tokensAsked).toEqual([]);
	});

	it("leaves every other machine word to hobo ci machine", async () => {
		const { run, registry } = await harness();
		await run(["connect", "--repo", "octo/app"]);
		const status = await run(["status"]);
		expect(status.exitCode).toBe(0);
		expect(status.stdout + status.stderr).toContain("studio");
		expect(status.stdout + status.stderr).toContain("offline");
		const [machine] = await registry.list("local");
		const removed = await run(["remove", machine?.id ?? ""]);
		expect(removed.exitCode).toBe(0);
		expect(await registry.list("local")).toEqual([]);
		const help = await run([]);
		expect(help.stdout + help.stderr).toContain("hobo ci machine connect");
		expect(help.stdout + help.stderr).toContain("hobo ci machine status");
	});

	it("is the machine command the table finds", () => {
		expect(findCiCommand("machine", CI_COMMANDS)).toBe(
			CI_MACHINE_CONNECT_COMMAND,
		);
	});
});
