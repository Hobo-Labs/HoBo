import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// C-8 of the #1593 review: every composed run left its `hobo-yard-*` event
// store in TMPDIR. ownedTempDir removes it on each way out a handler can reach.

const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");
const FIXTURE = fileURLToPath(
	new URL("./fixtures/owned-temp-dir.mts", import.meta.url),
);
const RUN_TIMEOUT_MS = 60_000;

let scratch = "";
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "hobo-owned-temp-dir-"));
});
afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

interface Ended {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	/** The directory the process made, from the first line it printed. */
	readonly dir: string;
}

/** How long a signalled process gets to end before it is killed, and the test fails. */
const SIGNAL_GRACE_MS = 15_000;

function run(mode: string, signal?: NodeJS.Signals): Promise<Ended> {
	const ready = join(scratch, "ready");
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			["--import", TSX_LOADER, FIXTURE, mode, ready],
			{
				env: {
					PATH: process.env.PATH ?? "",
					TMPDIR: scratch,
					NODE_NO_WARNINGS: "1",
				},
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
		const out: string[] = [];
		child.stdout.on("data", (chunk) => out.push(String(chunk)));
		child.on("error", reject);
		if (signal !== undefined) {
			const poll = setInterval(() => {
				if (!existsSync(ready)) return;
				clearInterval(poll);
				child.kill(signal);
				// A process that swallows the signal is not left running.
				const deadline = setTimeout(
					() => child.kill("SIGKILL"),
					SIGNAL_GRACE_MS,
				);
				child.on("close", () => clearTimeout(deadline));
			}, 20);
			child.on("close", () => clearInterval(poll));
		}
		child.on("close", (code, ended) => {
			const stdout = out.join("");
			resolve({
				code,
				signal: ended,
				stdout,
				dir: stdout.split("\n")[0] ?? "",
			});
		});
	});
}

function leftBehind(): string[] {
	return readdirSync(scratch).filter(
		(name) =>
			name.startsWith("hobo-yard-") || name.startsWith("hobo-pulumi-live-"),
	);
}

describe("ownedTempDir", () => {
	it(
		"is removed when the process ends normally",
		async () => {
			const ended = await run("normal");
			expect(ended.code).toBe(0);
			expect(ended.dir.startsWith(join(scratch, "hobo-yard-"))).toBe(true);
			expect(existsSync(ended.dir)).toBe(false);
			expect(leftBehind()).toEqual([]);
		},
		RUN_TIMEOUT_MS,
	);

	it(
		"is removed when the process ends on an uncaught error",
		async () => {
			const ended = await run("throw");
			expect(ended.code).toBe(1);
			expect(leftBehind()).toEqual([]);
		},
		RUN_TIMEOUT_MS,
	);

	for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
		it(
			`is removed on ${signal}, and the process still ends by it`,
			async () => {
				const ended = await run("wait", signal);
				expect(ended.signal).toBe(signal);
				expect(leftBehind()).toEqual([]);
			},
			RUN_TIMEOUT_MS,
		);
	}

	it(
		"installs one set of handlers however often the entry point asks, so a signal still ends the process",
		async () => {
			// A shell's loader may ask on every command. Two sets would each see
			// the other listening and defer to it, and SIGINT would be swallowed.
			const ended = await run("asked-twice", "SIGINT");
			expect(ended.signal).toBe("SIGINT");
			expect(leftBehind()).toEqual([]);
		},
		RUN_TIMEOUT_MS,
	);

	it(
		"removes every directory a process owns on a signal, which still ends it",
		async () => {
			const ended = await run("two", "SIGTERM");
			expect(ended.stdout.split("\n").filter(Boolean)).toHaveLength(2);
			expect(ended.signal).toBe("SIGTERM");
			expect(leftBehind()).toEqual([]);
		},
		RUN_TIMEOUT_MS,
	);

	it(
		"as a library, changes nothing about the host's signals: a SIGTERM the host emits to itself does not end it",
		async () => {
			// What the hobo suite's own serve-control test does, in a process that
			// composed a default runtime earlier: the library's handler took the
			// emit for a signal and ended the whole host (vitest, rc 143).
			const ended = await run("library-emit");
			expect(ended.code).toBe(0);
			expect(ended.stdout).toContain("host still running");
			expect(leftBehind()).toEqual([]);
		},
		RUN_TIMEOUT_MS,
	);

	it(
		"installs no signal handler in a worker thread, whose pid is the whole process's",
		async () => {
			const ended = await run("worker");
			expect(ended.code).toBe(0);
			expect(ended.stdout).toContain("worker ran");
			expect(ended.stdout).toContain("process still running after its worker");
		},
		RUN_TIMEOUT_MS,
	);

	it(
		"for an entry point, takes a signal it is emitted without a name as the one it listens for",
		async () => {
			const ended = await run("entry-emit-hup");
			expect(ended.signal).toBe("SIGHUP");
			expect(leftBehind()).toEqual([]);
		},
		RUN_TIMEOUT_MS,
	);

	it(
		"leaves a SIGTERM the process handles itself to that handler, and is removed when it exits",
		async () => {
			const ended = await run("graceful", "SIGTERM");
			expect(ended.code).toBe(0);
			expect(ended.signal).toBeNull();
			expect(ended.stdout).toContain("dir during stop: true");
			expect(leftBehind()).toEqual([]);
		},
		RUN_TIMEOUT_MS,
	);

	it(
		"leaves a SIGTERM to a handler the process installed before it asked, a once handler included",
		async () => {
			// A shell can install its own SIGTERM handler (a `once`) before a
			// command first loads the composition and asks for these. Run
			// after it, ours saw no other listener, since a once handler is gone by
			// the time the next listener runs, and ended the process mid-stop.
			const ended = await run("graceful-first", "SIGTERM");
			expect(ended.code).toBe(0);
			expect(ended.signal).toBeNull();
			expect(ended.stdout).toContain("dir during stop: true");
			expect(leftBehind()).toEqual([]);
		},
		RUN_TIMEOUT_MS,
	);
});
