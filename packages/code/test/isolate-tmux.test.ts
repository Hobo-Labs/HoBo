import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import { isolateTmux } from "./tmux-isolation.js";

// test/isolate-tmux.ts, run before every test file: a shell a test starts, or
// a `mux` it runs, must not reach the developer's tmux server or start their
// agent CLIs.
describe("each test file's tmux", () => {
	it("is a server of its own, under the test TMPDIR, and seats no agents", () => {
		expect(process.env.TMUX).toBeUndefined();
		expect(process.env.TMUX_TMPDIR).toMatch(
			new RegExp(
				`^${tmpdir().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/hobo-code-tmux-`,
				"u",
			),
		);
		expect(process.env.HOBO_CODE_SEAT_AGENTS).toBe("0");
	});

	it("has no server before a test starts one", () => {
		const listed = spawnSync("tmux", ["list-sessions"], {
			env: process.env,
			stdio: "ignore",
		});
		expect(listed.status).not.toBe(0);
	});

	it("kills the file's own server at the end, whatever a test did to TMUX or TMUX_TMPDIR, and no other", async () => {
		const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "" };
		const tmux = isolateTmux(env);
		const own = startServer(env);
		// The developer's server, which a test's $TMUX named.
		const elsewhere = mkdtempSync(join(tmpdir(), "hobo-code-tmux-other-"));
		const developers = join(elsewhere, "developer");
		const theirs = startServer({ PATH: env.PATH }, developers);
		try {
			env.TMUX = `${developers},${theirs},0`;
			env.TMUX_TMPDIR = elsewhere;
			tmux.end();
			// kill-server returns before the server has exited.
			const deadline = Date.now() + 10_000;
			while (running(own) && Date.now() < deadline) await sleep(50);
			expect(running(own), "the file's own server").toBe(false);
			expect(running(theirs), "the developer's server").toBe(true);
			expect(existsSync(tmux.socketDir)).toBe(false);
		} finally {
			for (const pid of [own, theirs]) {
				if (running(pid)) process.kill(pid, "SIGKILL");
			}
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});
});

/** Start a detached tmux session, on `socket` or as `env` says; its server's pid. */
function startServer(env: NodeJS.ProcessEnv, socket?: string): number {
	const at = socket === undefined ? [] : ["-S", socket];
	const started = spawnSync(
		"tmux",
		[...at, "new-session", "-d", "-P", "-F", "#{pid}", "sleep 600"],
		{ env, encoding: "utf8" },
	);
	const pid = Number.parseInt(started.stdout, 10);
	if (!Number.isSafeInteger(pid))
		throw new Error(`tmux did not start: ${started.stderr}`);
	return pid;
}

/** The process exists and is not a zombie. */
function running(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	return !/^\S+ \(.*\) Z/u.test(readStat(pid));
}

function readStat(pid: number): string {
	try {
		return readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		return "";
	}
}
