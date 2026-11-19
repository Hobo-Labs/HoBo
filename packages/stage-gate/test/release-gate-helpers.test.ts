import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { gone } from "./helpers/release-gate.js";

function stateOf(pid: number): string {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
	} catch {
		return "";
	}
}

const HAS_PYTHON3 = spawnSync("python3", ["-c", ""]).status === 0;

const LEADER_EXIT_PY = [
	"import ctypes, threading, time",
	"threading.Thread(target=time.sleep, args=(20,)).start()",
	"ctypes.CDLL(None).pthread_exit(None)",
].join("\n");

describe("gone", () => {
	it.runIf(process.platform === "linux")(
		"counts a process that has exited as gone, although its parent has not reaped it",
		async () => {
			const parent = spawn("sh", ["-c", "sleep 0 & echo $!; exec sleep 20"], {
				stdio: ["ignore", "pipe", "ignore"],
			});
			try {
				const zombie = await new Promise<number>((done) => {
					parent.stdout.once("data", (chunk: Buffer) =>
						done(Number(chunk.toString("utf8").trim())),
					);
				});
				const until = Date.now() + 20_000;
				while (stateOf(zombie) !== "Z" && Date.now() < until) {
					await new Promise((done) => setTimeout(done, 50));
				}
				expect(stateOf(zombie)).toBe("Z");
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
