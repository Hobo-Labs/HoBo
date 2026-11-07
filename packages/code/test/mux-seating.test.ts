import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runHoboCodeCli } from "../src/cli.js";

// HOBO_CODE_SEAT_AGENTS=0 turns agent seating off, and mux seats agents too:
// with it off, mux must start no agent CLI and no tmux session. It read only
// the shell's panes, so the verb sweep's bare `mux`, under the test setup's
// knob, started the agents found on PATH in tmux, working inside the HOBO_HOME
// the sweep then deleted under them.

const SESSION = "seat-test";

const roots: string[] = [];
afterEach(() => {
	tmux(["kill-session", "-t", SESSION]);
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

interface TmuxRun {
	readonly status: number | null;
	readonly out: string;
}

/** A machine for mux: a HOBO_HOME, stand-in agents on a PATH, their start log. */
interface Machine {
	readonly root: string;
	readonly home: string;
	readonly bin: string;
	readonly log: string;
}

/** tmux on this test file's own server (test/isolate-tmux.ts). */
function tmux(args: readonly string[]): TmuxRun {
	const ran = spawnSync("tmux", [...args], { encoding: "utf8" });
	return { status: ran.status, out: ran.stdout.trim() };
}

/** The processes whose working directory is under `dir`. */
function workingUnder(dir: string): number[] {
	return readdirSync("/proc")
		.filter((name) => /^\d+$/u.test(name))
		.map(Number)
		.filter((pid) => {
			try {
				return readlinkSync(`/proc/${pid}/cwd`).startsWith(dir);
			} catch {
				return false;
			}
		});
}

/** Stand-in agent CLIs on PATH that say they started, and then run on. */
function machine(): Machine {
	const root = mkdtempSync(join(tmpdir(), "hobo-mux-seat-"));
	roots.push(root);
	const home = join(root, "home");
	const bin = join(root, "bin");
	mkdirSync(home);
	mkdirSync(bin);
	const log = join(root, "started");
	for (const agent of ["claude", "codex"]) {
		writeFileSync(
			join(bin, agent),
			`#!/bin/sh\necho "${agent} $(pwd)" >> '${log}'\nexec sleep 60\n`,
		);
		chmodSync(join(bin, agent), 0o755);
	}
	return { root, home, bin, log };
}

async function mux(at: Machine, seating: "0" | "1"): Promise<void> {
	const result = await runHoboCodeCli(["mux", "--session", SESSION], {
		hoboHome: at.home,
		cwd: at.home,
		env: {
			PATH: `${at.bin}:/usr/bin:/bin`,
			HOME: at.home,
			HOBO_HOME: at.home,
			HOBO_CODE_SEAT_AGENTS: seating,
		},
		json: false,
	});
	expect(result.ok, result.message).toBe(true);
}

describe("hobo-code mux and HOBO_CODE_SEAT_AGENTS", () => {
	it("with seating off, starts no agent pane and no tmux session", async () => {
		const at = machine();
		await mux(at, "0");
		expect(tmux(["list-windows", "-t", SESSION]).status).not.toBe(0);
		expect(existsSync(at.log)).toBe(false);
		expect(workingUnder(at.root)).toEqual([]);
	});

	it("with seating on, seats the agents it finds (what the case above would see)", async () => {
		const at = machine();
		await mux(at, "1");
		const windows = tmux([
			"list-windows",
			"-t",
			SESSION,
			"-F",
			"#{window_name}",
		]).out.split("\n");
		expect(windows).toContain("codex");
	});
});
