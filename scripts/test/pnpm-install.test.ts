import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import {
	type InstallSpawner,
	parseInstallTimeoutSeconds,
	runPnpmInstall,
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
	const spawn: InstallSpawner = (command, args, options) => {
		calls.push({ command, args, detached: options.detached });
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
		// Every frozen-lockfile install names the wrapper on its own line; the
		// count is not pinned, so a new job does not have to edit this test.
		// The runner-image job's script-free install is the one exception: it
		// runs before the wrapper's own inputs exist (ci-runner-image-contract).
		const installs = workflow
			.split("\n")
			.filter((line) => line.includes("--frozen-lockfile"))
			.filter(
				(line) =>
					!line
						.trim()
						.startsWith("run: pnpm install --frozen-lockfile --ignore-scripts"),
			);
		assert.ok(installs.length > 0);
		for (const line of installs) {
			assert.ok(
				line.includes("scripts/ci/pnpm-install.mts"),
				`unbounded install: ${line.trim()}`,
			);
		}
		assert.doesNotMatch(workflow, /^\s*pnpm install --frozen-lockfile/mu);
	});
});
