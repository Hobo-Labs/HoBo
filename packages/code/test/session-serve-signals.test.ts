import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { testEnv } from "./test-env.js";

// `hobo-code session serve` runs a loopback session browser until a signal
// stops it, and closes its server before it ends. The launcher passes SIGHUP
// and SIGQUIT on as well as SIGINT and SIGTERM (a closing terminal is a
// SIGHUP), so each of the four must reach that close, not end the server
// where it stands.

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(pkgRoot, "bin", "hobo-code.mjs");
const SERVING_DEADLINE_MS = 120_000;
const STOP_GRACE_MS = 30_000;

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

interface Stopped {
	readonly served: boolean;
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly output: string;
}

/** Start `hobo-code session serve`, and once it is serving, send `signal` to hobo-code. */
function serveThenSignal(signal: NodeJS.Signals): Promise<Stopped> {
	const root = mkdtempSync(join(tmpdir(), "hobo-code-serve-"));
	roots.push(root);
	return new Promise((resolve, reject) => {
		const run = spawn(process.execPath, [launcher, "session", "serve"], {
			cwd: pkgRoot,
			env: testEnv({
				PATH: process.env.PATH ?? "",
				HOME: root,
				HOBO_HOME: join(root, "home"),
				TMPDIR: root,
				HOBO_CODE_FROM_SOURCE: "0",
				HOBO_CODE_SKIP_STALE_REBUILD: "1",
				NODE_NO_WARNINGS: "1",
			}),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let served = false;
		const timers: NodeJS.Timeout[] = [
			setTimeout(() => run.kill("SIGKILL"), SERVING_DEADLINE_MS),
		];
		const read = (chunk: Buffer): void => {
			output = `${output}${chunk.toString("utf8")}`;
			if (!served && /^browser: /mu.test(output)) {
				served = true;
				run.kill(signal);
				timers.push(setTimeout(() => run.kill("SIGKILL"), STOP_GRACE_MS));
			}
		};
		run.stdout.on("data", read);
		run.stderr.on("data", read);
		run.once("error", reject);
		run.once("close", (code, ended) => {
			for (const timer of timers) clearTimeout(timer);
			resolve({ served, code, signal: ended, output });
		});
	});
}

describe("hobo-code session serve, stopped by a signal", () => {
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
		it(
			`${signal}: closes its server and ends with status 0`,
			async () => {
				const stopped = await serveThenSignal(signal);
				expect(stopped.served, stopped.output).toBe(true);
				expect(stopped.signal).toBeNull();
				expect(stopped.code, stopped.output).toBe(0);
			},
			SERVING_DEADLINE_MS + STOP_GRACE_MS,
		);
	}
});
