import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
	assertNoLeakedEvidenceSidecars,
	killProcessGroup,
	trackChild,
} from "./subprocess-cleanup.js";

/**
 * The Evidence worker is spawned `detached` + `unref`ed on purpose, so nothing
 * in the OS collects it when the session that started it dies. These tests pin
 * the two conditions under which it collects itself instead — without them a
 * vitest worker killed mid-file leaves a ~135 MB process resident forever.
 */
const MAIN = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"dist",
	"evidence-sidecar-main.js",
);

const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
	for (const child of children) {
		if (child.pid !== undefined) killProcessGroup(child.pid);
	}
	children.length = 0;
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs.length = 0;
	assertNoLeakedEvidenceSidecars();
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

async function startWorker(
	env: Readonly<Record<string, string>>,
): Promise<{ readonly child: ChildProcess; readonly home: string }> {
	const home = tempDir("hobo-evidence-reap-home-");
	const project = tempDir("hobo-evidence-reap-proj-");
	const readyPath = join(tempDir("hobo-evidence-reap-ready-"), "ready.json");
	const child = spawn(process.execPath, [MAIN], {
		detached: true,
		stdio: "ignore",
		env: {
			...process.env,
			HOBO_HOME: home,
			HOBO_CODE_SIDECAR_READY: readyPath,
			HOBO_CODE_SIDECAR_ROOT: project,
			HOBO_CODE_EVIDENCE_PORT: "0",
			HOBO_CODE_SIDECAR_POLL_MS: "50",
			...env,
		},
	});
	trackChild(child);
	children.push(child);
	child.unref();
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (existsSync(readyPath)) return { child, home };
		if (child.exitCode !== null) {
			throw new Error(`worker exited early with ${String(child.exitCode)}`);
		}
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("worker never reported ready");
}

function exited(child: ChildProcess, withinMs: number): Promise<number> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`worker still alive after ${withinMs}ms`)),
			withinMs,
		);
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolve(code ?? -1);
		});
	});
}

describe("Evidence sidecar reaper", () => {
	it("exits once its Station home is gone", async () => {
		const { child, home } = await startWorker({
			// No cap: prove the home check alone is what collects it.
			HOBO_CODE_SIDECAR_MAX_MS: "3600000",
		});
		expect(child.exitCode).toBeNull();
		rmSync(home, { recursive: true, force: true });
		await expect(exited(child, 5_000)).resolves.toBe(0);
	}, 25_000);

	it("exits at its lifetime cap even while the home survives", async () => {
		const { child, home } = await startWorker({
			HOBO_CODE_SIDECAR_MAX_MS: "300",
		});
		await expect(exited(child, 5_000)).resolves.toBe(0);
		expect(existsSync(home)).toBe(true);
	}, 25_000);

	it("stays up while the home exists and no cap has elapsed", async () => {
		const { child } = await startWorker({
			HOBO_CODE_SIDECAR_MAX_MS: "3600000",
		});
		await new Promise((r) => setTimeout(r, 500));
		expect(child.exitCode).toBeNull();
	}, 25_000);
});
