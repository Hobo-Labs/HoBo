import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	readHandedWorkerSecrets,
	WORKER_STARTED_EVENT,
	waitForWorkerStart,
	workerSecretsPayload,
} from "../src/worker-secrets.js";

describe("readHandedWorkerSecrets", () => {
	it("reads the payload from the descriptor the host names", () => {
		const payload = workerSecretsPayload({
			githubAppPrivateKey: "pem",
			webhookSecret: "s",
		});
		const reads: number[] = [];
		expect(
			readHandedWorkerSecrets({ HOBO_CI_WORKER_SECRETS_FD: "3" }, (fd) => {
				reads.push(fd);
				return payload;
			}),
		).toEqual({ githubAppPrivateKey: "pem", webhookSecret: "s" });
		expect(reads).toEqual([3]);
	});

	it("reads nothing without one, and refuses a bad descriptor or payload", () => {
		expect(readHandedWorkerSecrets({})).toBeUndefined();
		expect(() =>
			readHandedWorkerSecrets({ HOBO_CI_WORKER_SECRETS_FD: "0" }),
		).toThrow(/inherited descriptor/u);
		expect(() =>
			readHandedWorkerSecrets(
				{ HOBO_CI_WORKER_SECRETS_FD: "3" },
				() => '{"githubAppPrivateKey":"pem","extra":"x"}',
			),
		).toThrow(/not valid/u);
	});
});

const child = (source: string) =>
	spawn(process.execPath, ["-e", source], {
		stdio: ["ignore", "ignore", "pipe"],
	});

describe("waitForWorkerStart", () => {
	it("reports a spawn failure instead of waiting for readiness", async () => {
		// A binary in a fresh empty directory: it does not exist, and nothing here creates it.
		const missing = join(mkdtempSync(join(tmpdir(), "hobo-worker-")), "absent");
		const worker = spawn(missing, [], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		// Keep the before-fix failure inside this test rather than crashing Vitest.
		worker.on("error", () => {});
		await expect(
			waitForWorkerStart(worker, { timeoutMs: 200 }),
		).rejects.toThrow(/could not start/u);
	});

	it("resolves when the worker logs that it started", async () => {
		const worker = child(
			`console.error(JSON.stringify({event:${JSON.stringify(WORKER_STARTED_EVENT)}})); setTimeout(()=>{}, 5000)`,
		);
		try {
			await expect(
				waitForWorkerStart(worker, { timeoutMs: 10_000 }),
			).resolves.toBeUndefined();
		} finally {
			worker.kill();
		}
	});

	it("rejects when the worker exits before it starts, or does not start in time", async () => {
		await expect(
			waitForWorkerStart(child("process.exit(3)"), { timeoutMs: 10_000 }),
		).rejects.toThrow(/exited before it started \(exit 3\)/u);
		await expect(
			waitForWorkerStart(child("setTimeout(()=>{}, 5000)"), { timeoutMs: 200 }),
		).rejects.toThrow(/did not start within 200 ms/u);
	});
});
