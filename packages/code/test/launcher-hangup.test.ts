import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
	hangUpWhenLauncherGoes,
	type LaunchedProcess,
} from "../src/launcher-hangup.js";
import { testEnv } from "./test-env.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(pkgRoot, "src", "bin", "hobo-code.ts");
const tsx = createRequire(import.meta.url).resolve("tsx");

interface Watched extends LaunchedProcess {
	readonly kills: string[];
	/** How often the channel was told to keep nothing running. */
	unrefs(): number;
	/** Close the launcher's end: the `disconnect` the process listens for. */
	disconnect(): void;
}

/** A process as its launcher left it: with or without a channel, connected or not. */
function launched(
	state: "no channel" | "connected" | "closed" | "not connected",
	platform: NodeJS.Platform = "linux",
): Watched {
	const kills: string[] = [];
	const listeners: (() => void)[] = [];
	let unrefs = 0;
	const channel = {
		unref: () => {
			unrefs += 1;
		},
	};
	const started = {
		pid: 4242,
		platform,
		connected: state === "connected",
		once: (_event: "disconnect", listener: () => void) => {
			listeners.push(listener);
		},
		kill: (pid: number, signal: NodeJS.Signals) => {
			kills.push(`${pid} ${signal}`);
		},
		kills,
		unrefs: () => unrefs,
		disconnect: () => {
			for (const listener of listeners.splice(0)) listener();
		},
	};
	if (state === "no channel") return started;
	return {
		...started,
		send: () => true,
		channel: state === "closed" ? null : channel,
	};
}

describe("hangUpWhenLauncherGoes", () => {
	it("does nothing in a process started without an IPC channel", () => {
		const proc = launched("no channel");
		hangUpWhenLauncherGoes(proc);
		proc.disconnect();
		expect(proc.kills).toEqual([]);
	});

	it("hangs up when the launcher's end closes, and keeps nothing running meanwhile", () => {
		const proc = launched("connected");
		hangUpWhenLauncherGoes(proc);
		expect(proc.unrefs()).toBe(1);
		expect(proc.kills).toEqual([]);
		proc.disconnect();
		expect(proc.kills).toEqual(["4242 SIGHUP"]);
	});

	it("hangs up at once when the launcher went while the process was still loading", () => {
		// Its `disconnect` came before anything listened, and Node set the
		// channel to null: reading `.unref()` off it threw.
		for (const state of ["closed", "not connected"] as const) {
			const proc = launched(state);
			expect(() => hangUpWhenLauncherGoes(proc)).not.toThrow();
			expect(proc.kills).toEqual(["4242 SIGHUP"]);
		}
	});

	it("does nothing on Windows, where the child shares the launcher's console", () => {
		for (const state of ["connected", "closed"] as const) {
			const proc = launched(state, "win32");
			hangUpWhenLauncherGoes(proc);
			proc.disconnect();
			expect(proc.kills).toEqual([]);
		}
	});
});

const roots: string[] = [];
const pids: number[] = [];
afterEach(() => {
	for (const pid of pids.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone, as it should be.
		}
	}
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("the hobo-code entry, its launcher gone before it finished loading", () => {
	it("ends, rather than throwing or serving on with no one to stop it", async () => {
		// A launcher that starts the real entry with an IPC channel, as
		// bin/hobo-code.mjs does, and is gone at once: the entry is still
		// loading its modules. `session serve` runs until a signal ends it.
		const root = mkdtempSync(join(tmpdir(), "hobo-code-hangup-"));
		roots.push(root);
		const launcher = join(root, "launcher.mjs");
		writeFileSync(
			launcher,
			`import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["--import", ${JSON.stringify(tsx)}, ${JSON.stringify(entry)}, "session", "serve"], {
	stdio: ["ignore", "inherit", "inherit", "ipc"],
	detached: true,
});
process.stdout.write(\`\${child.pid}\\n\`);
process.exit(0);
`,
		);
		const run = spawn(process.execPath, [launcher], {
			cwd: pkgRoot,
			env: testEnv({
				PATH: process.env.PATH ?? "",
				HOME: root,
				HOBO_HOME: join(root, "home"),
				TMPDIR: root,
				NODE_NO_WARNINGS: "1",
			}),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		run.stdout.on("data", (chunk) => {
			stdout = `${stdout}${chunk}`;
			const pid = Number.parseInt(stdout, 10);
			if (Number.isSafeInteger(pid) && !pids.includes(pid)) pids.push(pid);
		});
		run.stderr.on("data", (chunk) => {
			stderr = `${stderr}${chunk}`;
		});
		// The child holds the launcher's stdout and stderr: they close when it ends.
		const ended = await new Promise<boolean>((resolve) => {
			const deadline = setTimeout(() => resolve(false), 90_000);
			run.once("close", () => {
				clearTimeout(deadline);
				resolve(true);
			});
		});
		expect(stderr).not.toMatch(/Cannot read properties of null/u);
		expect(ended, `${stdout}\n${stderr}`).toBe(true);
	}, 120_000);
});
