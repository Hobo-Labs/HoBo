import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLocalDeploymentLock } from "../src/local-deployment-lock.js";

describe("local deployment operation locking", () => {
	it("refuses live contenders and releases without deleting the lock database", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hobo-deployment-lock-"));
		try {
			const release = acquireLocalDeploymentLock(directory);
			try {
				expect(() => acquireLocalDeploymentLock(directory)).toThrow(
					"Another hobo up operation holds the local deployment lock",
				);
			} finally {
				release();
			}
			const releaseNext = acquireLocalDeploymentLock(directory);
			releaseNext();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("recovers immediately after an actual lock owner is killed", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hobo-deployment-crash-"));
		const module = new URL("../src/local-state-lock.ts", import.meta.url);
		const child = spawn(
			process.execPath,
			[
				"--experimental-strip-types",
				"--input-type=module",
				"--eval",
				`import { acquireLocalStateLock } from ${JSON.stringify(module.href)};
acquireLocalStateLock(${JSON.stringify(join(directory, "local-deployment-lock.sqlite"))});
process.send({ ready: true });
setInterval(() => {}, 1000);`,
			],
			{ stdio: ["ignore", "ignore", "pipe", "ipc"] },
		);
		try {
			await Promise.race([
				once(child, "message"),
				once(child, "exit").then(() => {
					throw new Error("Lock owner exited before readiness");
				}),
			]);
			expect(() => acquireLocalDeploymentLock(directory)).toThrow(
				"Another hobo up operation holds the local deployment lock",
			);
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
			const release = acquireLocalDeploymentLock(directory);
			release();
		} finally {
			child.kill("SIGKILL");
			await rm(directory, { recursive: true, force: true });
		}
	}, 15_000);
});
