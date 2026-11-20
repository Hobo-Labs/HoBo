/**
 * The release-gate suites' own helpers (test/helpers/release-gate.ts): what
 * their assertions about processes rest on.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { gone } from "./helpers/release-gate.js";

const HAS_PYTHON3 = spawnSync("python3", ["-c", ""]).status === 0;

const ZOMBIE_PARENT_PY = [
	"import subprocess, time",
	'child = subprocess.Popen(["sleep", "0"])',
	"print(child.pid, flush=True)",
	"time.sleep(20)",
].join("\n");

/** Ends its main thread (pthread_exit) with a thread that runs for 20 s: /proc says `State: Z`, `Threads: 2`. */
const LEADER_EXIT_PY = [
	"import ctypes, threading, time",
	"threading.Thread(target=time.sleep, args=(20,)).start()",
	"ctypes.CDLL(None).pthread_exit(None)",
].join("\n");

describe("gone", () => {
	it.runIf(process.platform === "linux" && HAS_PYTHON3)(
		"counts a process that has exited as gone, although its parent has not reaped it",
		async () => {
			const parent = spawn("python3", ["-c", ZOMBIE_PARENT_PY], {
				stdio: ["ignore", "pipe", "ignore"],
			});
			try {
				const zombie = await new Promise<number>((done) => {
					parent.stdout.once("data", (chunk: Buffer) =>
						done(Number(chunk.toString("utf8").trim())),
					);
				});
				const started = Date.now();
				expect(await gone(zombie)).toBe(true);
				expect(Date.now() - started).toBeLessThan(1000);
			} finally {
				parent.kill("SIGKILL");
			}
		},
		40_000,
	);

	it.runIf(process.platform === "linux" && HAS_PYTHON3)(
		"is false for a process whose main thread exited while its other threads run, although /proc shows it Z",
		async () => {
			const member = spawn("python3", ["-c", LEADER_EXIT_PY], {
				stdio: "ignore",
			});
			try {
				const pid = member.pid ?? 0;
				const status = () => {
					try {
						return readFileSync(`/proc/${pid}/status`, "utf8");
					} catch {
						return "";
					}
				};
				const until = Date.now() + 20_000;
				while (!/^State:\s+Z/mu.test(status()) && Date.now() < until) {
					await new Promise((done) => setTimeout(done, 50));
				}
				// The premise: zombie by its state line, yet running (two threads).
				expect(status()).toMatch(/^State:\s+Z/mu);
				expect(status()).toMatch(/^Threads:\s+2$/mu);
				expect(await gone(pid, 5)).toBe(false);
			} finally {
				member.kill("SIGKILL");
			}
		},
		40_000,
	);

	it("is false for a process that is still running", async () => {
		expect(await gone(process.pid, 3)).toBe(false);
	});
});
