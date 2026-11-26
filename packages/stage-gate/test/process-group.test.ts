/**
 * scanGroup (ADR-0172): what the process table shows of ai-bdd's group once
 * kill(-pgid, 0) has found a member. Most cases read a process table laid out
 * in a temp dir; the odd comm reads the real one.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { scanGroup } from "../src/process-group.js";
import { GROUP, procTables, zombie } from "./helpers/proc-table.js";

const tables = procTables();
afterAll(tables.remove);
const { table } = tables;
const scratch = tables.dir;

const childProgram = `
const { readFileSync } = require("node:fs");
process.title = "a) Z 1 2 (b";
const zombiePid = process.argv[1];
const signalWhenZombie = () => {
	let stat = "";
	try {
		stat = readFileSync(\`/proc/\${zombiePid}/stat\`, "utf8");
	} catch {}
	const close = stat.lastIndexOf(")");
	if (stat.slice(close + 2, close + 3) !== "Z") {
		setTimeout(signalWhenZombie, 10);
		return;
	}
	process.stdout.write("ready\\n");
};
signalWhenZombie();
setInterval(() => {}, 1 << 30);
`;

describe("scanGroup", () => {
	it("is zombies for a group whose members are all zombies of one thread", () => {
		expect(scanGroup(GROUP, table([zombie(100), zombie(101)]))).toBe("zombies");
	});

	it("is live while a member whose main thread exited still runs other threads", () => {
		// Linux shows such a thread-group leader as Z, with num_threads above 1.
		const leaderExited = { ...zombie(101), comm: "python3", threads: 2 };
		expect(scanGroup(GROUP, table([zombie(100), leaderExited]))).toBe("live");
	});

	it("is live for a Z member whose num_threads is not 1: only a zombie of one thread is let go", () => {
		// Linux never writes 0 or a word there; a line that does is not read as a zombie.
		for (const threads of [0, Number.NaN]) {
			const odd = { ...zombie(101), threads };
			expect(scanGroup(GROUP, table([zombie(100), odd]))).toBe("live");
		}
	});

	it("is live when the table shows no member, as a /proc of another PID namespace does", () => {
		// kill(-pgid, 0) has just found a member: a table that shows none cannot say it is gone.
		const elsewhere = { ...zombie(100), state: "S", pgrp: 7 };
		expect(scanGroup(GROUP, table([elsewhere]))).toBe("live");
		expect(scanGroup(GROUP, table([]))).toBe("live");
	});

	it("is elsewhere when the pgid shows only in another session's processes: the number was reused", () => {
		// Ours leads its own session; a process that took the freed number for a group of its own did not.
		const stranger = { ...zombie(100), state: "S", session: 77 };
		expect(scanGroup(GROUP, table([stranger]))).toBe("elsewhere");
	});

	it("is live when the table is not this PID namespace's: its self names another pid", () => {
		const stranger = { ...zombie(100), state: "S", session: 77 };
		expect(scanGroup(GROUP, table([stranger], process.pid + 1))).toBe("live");
		expect(scanGroup(GROUP, table([zombie(101)], process.pid + 1))).toBe(
			"live",
		);
	});

	it("is live when an entry's stat cannot be read for a reason other than its process being gone", () => {
		// EISDIR here; EACCES under hidepid=1 for another user's process, EMFILE at the fd limit.
		// Such an entry may be a member the scan cannot see, so beside a zombie it is not a group of zombies.
		const root = table([zombie(100)]);
		mkdirSync(join(root, "101", "stat"), { recursive: true });
		expect(scanGroup(GROUP, root)).toBe("live");
	});

	it("is live without a readable table", () => {
		expect(scanGroup(GROUP, join(scratch, "no-such-proc"))).toBe("live");
	});

	it.runIf(process.platform === "linux")(
		"reads the fields after the last ')': a live process named 'a) Z 1 2 (b' beside a zombie is live",
		async () => {
			// Node 24 names its main thread MainThread during startup, so set comm after that.
			// The detached shell leaves `sleep 0` unreaped; Node signals after seeing its Z state.
			const named = join(scratch, "a) Z 1 2 (b");
			symlinkSync(process.execPath, named);
			const leader = spawn(
				"sh",
				[
					"-c",
					'sleep 0 & zombie=$!; echo "$zombie"; exec "$0" -e "$1" "$zombie"',
					named,
					childProgram,
				],
				{ detached: true, stdio: ["ignore", "pipe", "ignore"] },
			);
			const pgid = leader.pid ?? 0;
			try {
				const zombiePid = await new Promise<string>((done) => {
					let output = "";
					leader.stdout.on("data", (chunk: Buffer) => {
						output += chunk.toString("utf8");
						const [pid, signal] = output.split("\n");
						if (pid && signal === "ready") done(pid);
					});
				});
				const ready = () =>
					stateOf(String(pgid)).comm === "a) Z 1 2 (b" &&
					stateOf(zombiePid).state === "Z";
				expect(
					ready(),
					`never ready: ${statLineOf(String(pgid))} | ${statLineOf(zombiePid)}`,
				).toBe(true);
				expect(scanGroup({ pgid, sid: pgid }, "/proc")).toBe("live");
			} finally {
				killGroup(pgid);
			}
		},
		40_000,
	);
});

function killGroup(pgid: number): void {
	try {
		process.kill(-pgid, "SIGKILL");
	} catch (cause) {
		if (!hasErrorCode(cause, "ESRCH")) throw cause;
	}
}

function hasErrorCode(
	cause: unknown,
	code: string,
): cause is NodeJS.ErrnoException {
	return cause instanceof Error && "code" in cause && cause.code === code;
}

/** A process's /proc stat line as it reads now, for a failure message. */
function statLineOf(pid: string): string {
	try {
		return readFileSync(`/proc/${pid}/stat`, "utf8").trim();
	} catch (cause) {
		return `/proc/${pid}/stat unreadable: ${cause instanceof Error ? cause.message : String(cause)}`;
	}
}

interface ProcState {
	readonly comm: string;
	readonly state: string;
}

/** The comm and state of a real process, read independently of scanGroup. */
function stateOf(pid: string): ProcState {
	let stat: string;
	try {
		stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		return { comm: "", state: "" };
	}
	const close = stat.lastIndexOf(")");
	return {
		comm: stat.slice(stat.indexOf("(") + 1, close),
		state: stat.slice(close + 2, close + 3),
	};
}
