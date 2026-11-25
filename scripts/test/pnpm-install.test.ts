import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import {
	type InstallSpawner,
	latestProgress,
	parseInstallTimeoutSeconds,
	runPnpmInstall,
	withFleetPnpmStore,
} from "../ci/pnpm-install.mts";

class FakeInstallProcess extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();

	constructor(readonly pid: number) {
		super();
	}

	finish(code: number | null, output = ""): void {
		if (output) this.stderr.write(output);
		this.emit("close", code, code === null ? "SIGKILL" : null);
	}
}

function createHarness(timeoutSeconds = "1") {
	let nowMs = 0;
	const tasks: {
		callback: () => void;
		delayMs: number;
		cancelled: boolean;
	}[] = [];
	const children: FakeInstallProcess[] = [];
	const calls: {
		command: string;
		args: readonly string[];
		detached?: boolean;
	}[] = [];
	const signals: { pid: number; signal: NodeJS.Signals }[] = [];
	const traces: string[] = [];
	const output: string[] = [];
	const envs: NodeJS.ProcessEnv[] = [];
	const spawn: InstallSpawner = (command, args, options) => {
		calls.push({ command, args, detached: options.detached });
		envs.push(options.env);
		const child = new FakeInstallProcess(1000 + children.length);
		children.push(child);
		return child;
	};
	const options = {
		env: { HOBO_PNPM_INSTALL_TIMEOUT_S: timeoutSeconds },
		spawn,
		now: () => nowMs,
		schedule(callback: () => void, delayMs: number) {
			const task = { callback, delayMs, cancelled: false };
			tasks.push(task);
			return () => {
				task.cancelled = true;
			};
		},
		killProcessGroup(pid: number, signal: NodeJS.Signals) {
			signals.push({ pid, signal });
		},
		writeOutput(_stream: "stdout" | "stderr", text: string) {
			output.push(text);
		},
		log(line: string) {
			traces.push(line);
		},
	};

	return {
		children,
		envs,
		pendingDelays: () =>
			tasks.filter((task) => !task.cancelled).map((task) => task.delayMs),
		calls,
		signals,
		traces,
		output,
		options,
		runNext() {
			while (tasks.length > 0) {
				const task = tasks.shift();
				if (!task) break;
				if (task.cancelled) continue;
				nowMs += task.delayMs;
				task.callback();
				return;
			}
			throw new Error("no scheduled task");
		},
	};
}

async function flushAttempts(): Promise<void> {
	for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe("bounded pnpm install", () => {
	it("succeeds on the first attempt without adding flags", async () => {
		const harness = createHarness();
		const result = runPnpmInstall(["--frozen-lockfile"], harness.options);
		assert.equal(harness.calls.length, 1);
		assert.deepEqual(harness.calls[0], {
			command: "pnpm",
			args: ["install", "--frozen-lockfile"],
			detached: true,
		});
		harness.children[0]?.finish(0);
		assert.equal(await result, 0);
		assert.equal(harness.calls.length, 1);
		assert.deepEqual(JSON.parse(harness.traces[0] ?? ""), {
			attempt: 1,
			args: ["install", "--frozen-lockfile"],
			outcome: "success",
			durationMs: 0,
		});
	});

	it("kills a timed-out process group and retries once with prefer-offline", async () => {
		const harness = createHarness();
		const result = runPnpmInstall(["--frozen-lockfile"], harness.options);
		harness.runNext();
		assert.deepEqual(harness.signals, [{ pid: 1000, signal: "SIGTERM" }]);
		harness.runNext();
		assert.deepEqual(harness.signals, [
			{ pid: 1000, signal: "SIGTERM" },
			{ pid: 1000, signal: "SIGKILL" },
		]);
		harness.children[0]?.finish(null);
		await flushAttempts();
		assert.equal(harness.calls.length, 2);
		assert.deepEqual(harness.calls[1]?.args, [
			"install",
			"--frozen-lockfile",
			"--prefer-offline",
		]);
		harness.children[1]?.finish(0);
		assert.equal(await result, 0);
		assert.equal(JSON.parse(harness.traces[0] ?? "").outcome, "timeout");
		assert.equal(JSON.parse(harness.traces[1] ?? "").outcome, "success");
	});

	it("keeps an install alive while pnpm reports progress and kills it only once it stalls", async () => {
		const harness = createHarness();
		const result = runPnpmInstall(["--frozen-lockfile"], harness.options);
		const child = harness.children[0];
		child?.stdout.write(
			"Progress: resolved 818, reused 0, downloaded 1, added 0\n",
		);
		await flushAttempts();
		child?.stdout.write(
			"Progress: resolved 818, reused 0, downloaded 2, added 0\n",
		);
		await flushAttempts();
		assert.deepEqual(harness.pendingDelays(), [1_000]);
		child?.stdout.write(
			"Progress: resolved 818, reused 0, downloaded 2, added 0\n",
		);
		await flushAttempts();
		assert.deepEqual(harness.signals, []);
		harness.runNext();
		assert.deepEqual(harness.signals, [{ pid: 1000, signal: "SIGTERM" }]);
		child?.finish(null);
		await flushAttempts();
		harness.children[1]?.finish(0);
		assert.equal(await result, 0);
		assert.equal(JSON.parse(harness.traces[0] ?? "").outcome, "timeout");
	});

	it("reads the last pnpm progress counters in a chunk", () => {
		assert.equal(
			latestProgress(
				"Progress: resolved 1, reused 0, downloaded 0, added 0\nProgress: resolved 818, reused 406, downloaded 410, added 219\n",
			),
			"818,406,410,219",
		);
		assert.equal(
			latestProgress(" WARN  Tarball download average speed"),
			undefined,
		);
	});

	it("installs into the node-shared fleet store when the runner names a writable one", async () => {
		const harness = createHarness();
		const result = runPnpmInstall([], {
			...harness.options,
			env: {
				...harness.options.env,
				HOBO_CI_PNPM_STORE_DIR: "/pnpm-store",
			},
			storeWritable: (path) => path === "/pnpm-store",
		});
		assert.equal(harness.envs[0]?.npm_config_store_dir, "/pnpm-store");
		harness.children[0]?.finish(0);
		assert.equal(await result, 0);
	});

	it("leaves an explicit, relative or unwritable store alone", () => {
		const writable = () => true;
		assert.equal(
			withFleetPnpmStore(
				{ npm_config_store_dir: "/box", HOBO_CI_PNPM_STORE_DIR: "/pnpm-store" },
				writable,
			).npm_config_store_dir,
			"/box",
		);
		assert.equal(
			withFleetPnpmStore({ HOBO_CI_PNPM_STORE_DIR: "pnpm-store" }, writable)
				.npm_config_store_dir,
			undefined,
		);
		assert.equal(
			withFleetPnpmStore({ HOBO_CI_PNPM_STORE_DIR: "/pnpm-store" }, () => false)
				.npm_config_store_dir,
			undefined,
		);
		assert.equal(
			withFleetPnpmStore({}, writable).npm_config_store_dir,
			undefined,
		);
	});

	it("returns the second failure status after exactly one retry", async () => {
		const harness = createHarness();
		const result = runPnpmInstall([], harness.options);
		harness.children[0]?.finish(1);
		await flushAttempts();
		assert.equal(harness.calls.length, 2);
		harness.children[1]?.finish(7);
		assert.equal(await result, 7);
		assert.equal(harness.calls.length, 2);
		assert.deepEqual(
			harness.traces.map((line) => JSON.parse(line).outcome),
			["failed", "failed"],
		);
	});

	it("does not retry an outdated frozen lockfile", async () => {
		const harness = createHarness();
		const result = runPnpmInstall(["--frozen-lockfile"], harness.options);
		harness.children[0]?.finish(1, "ERR_PNPM_OUTDATED_LOCKFILE");
		assert.equal(await result, 1);
		assert.equal(harness.calls.length, 1);
		assert.equal(
			JSON.parse(harness.traces[0] ?? "").outcome,
			"lockfile-mismatch",
		);
		assert.ok(harness.output.includes("ERR_PNPM_OUTDATED_LOCKFILE"));
	});

	it("rejects invalid timeout environment values before spawning", async () => {
		for (const value of ["", "0", "-1", "1.5", "1s", "Infinity"]) {
			const harness = createHarness(value);
			await assert.rejects(
				runPnpmInstall([], harness.options),
				/HOBO_PNPM_INSTALL_TIMEOUT_S/u,
			);
			assert.equal(harness.calls.length, 0);
		}
		assert.equal(parseInstallTimeoutSeconds(undefined), 180);
		assert.equal(parseInstallTimeoutSeconds("240"), 240);
	});

	it("routes every workflow install through the bounded wrapper", () => {
		const workflow = readFileSync(".github/workflows/hobo-ci.yml", "utf8");
		const lines = workflow.split("\n");
		const wrapped = lines.filter((line) =>
			line.includes("scripts/ci/pnpm-install.mts"),
		);
		assert.ok(wrapped.length > 0);
		for (const line of wrapped) {
			assert.ok(line.includes("--frozen-lockfile"), line.trim());
		}
		assert.deepEqual(
			lines
				.filter((line) => /\bpnpm (?:install|i)\b/u.test(line))
				.map((line) => line.trim()),
			[],
		);
		assert.ok(
			wrapped.some((line) => line.includes("--ignore-scripts")),
			"the runner-image job installs without lifecycle scripts",
		);
		assert.doesNotMatch(workflow, /^\s*pnpm install --frozen-lockfile/mu);
	});
});
