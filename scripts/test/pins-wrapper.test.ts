/**
 * The deadline wrapper (UNDER_DEADLINE) starts git in a session of its own,
 * so a terminal's Ctrl-C reaches git only through the wrapper. Its signal
 * listeners therefore exist before git does: a signal handled before the
 * spawn ends the wrapper with 130 and git never starts, and one after it is
 * passed on to git's group. Either way no git outlives the run.
 *
 * The wrapper runs in its own process group here and the test signals that
 * group, as a terminal does; a `git` on PATH records its pid and waits.
 * Whether that git is still alive is read from /proc.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { UNDER_DEADLINE } from "../lib/pins-git-core.ts";
import { scratch } from "./support/pins-support.ts";

const RUNS = 30;
const PROC = existsSync("/proc/self/stat");
const NO_PROC = PROC ? false : "no /proc to tell a live git from a zombie";

function running(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return !/^\d+ \(.*\) Z/u.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
	} catch {
		return false;
	}
}

const pause = (ms: number) =>
	new Promise<undefined>((resolve) => setTimeout(resolve, ms));

interface Rig {
	readonly dir: string;
	readonly mark: string;
	readonly start: (nodeOptions?: string) => ChildProcess;
	readonly started: () => boolean;
}

/** A `git` on PATH that writes its pid to `mark` and sleeps. */
function rig(): Rig {
	const dir = scratch("wrapper");
	const bin = join(dir, "bin");
	mkdirSync(bin);
	writeFileSync(
		join(bin, "git"),
		'#!/bin/sh\necho $$ > "$HANG_MARK"\nexec sleep 30\n',
		{ mode: 0o755 },
	);
	const mark = join(dir, "mark");
	return {
		dir,
		mark,
		start: (nodeOptions = "") => {
			rmSync(mark, { force: true });
			return spawn(
				process.execPath,
				["-e", UNDER_DEADLINE, "600000", "fetch", "x"],
				{
					detached: true,
					stdio: "ignore",
					env: {
						...process.env,
						NODE_OPTIONS: nodeOptions,
						HANG_MARK: mark,
						PATH: `${bin}:${process.env.PATH ?? ""}`,
					},
				},
			);
		},
		started: () => existsSync(mark) && readFileSync(mark, "utf8").trim() !== "",
	};
}

/** How the wrapper ended: its exit code, its signal, or undefined. */
function ending(wrapper: ChildProcess): Promise<string | undefined> {
	const exited = new Promise<string>((resolve) =>
		wrapper.on("exit", (code, signal) => resolve(`${code ?? signal}`)),
	);
	return Promise.race([exited, pause(3000)]);
}

/** Kill what is left of a run; true when its git was still alive. */
function sweep(wrapper: ChildProcess, setup: Rig): boolean {
	let survived = false;
	if (setup.started()) {
		const git = Number(readFileSync(setup.mark, "utf8"));
		survived = running(git);
		if (survived) process.kill(git, "SIGKILL");
	}
	try {
		process.kill(-(wrapper.pid ?? 0), "SIGKILL");
	} catch {
		// Already gone.
	}
	return survived;
}

describe("the deadline wrapper and a signal to its group", () => {
	for (const when of ["once git has started", "at once"] as const) {
		it(`${when}: no git survives, ${RUNS} runs`, {
			skip: NO_PROC,
		}, async (t) => {
			const setup = rig();
			const survivors: number[] = [];
			const startedThen130: number[] = [];
			const endings = new Map<string, number>();
			for (let run = 0; run < RUNS; run += 1) {
				const wrapper = setup.start();
				if (when === "once git has started") {
					while (!setup.started())
						await new Promise((resolve) => setImmediate(resolve));
				}
				process.kill(-(wrapper.pid ?? 0), "SIGINT");
				const end = await ending(wrapper);
				await pause(200);
				const key = `${end ?? "still running"}${setup.started() ? ", git started" : ""}`;
				endings.set(key, (endings.get(key) ?? 0) + 1);
				if (end === "130" && setup.started()) startedThen130.push(run);
				if (sweep(wrapper, setup)) survivors.push(run);
			}
			t.diagnostic(JSON.stringify(Object.fromEntries(endings)));
			assert.deepEqual(survivors, [], "runs in which git outlived the signal");
			assert.deepEqual(
				startedThen130,
				[],
				"runs that exited 130 after git started",
			);
		});
	}

	it("a signal pending once the listeners exist: 130, git never starts", {
		skip: NO_PROC,
	}, async () => {
		const setup = rig();
		// The wrapper signals itself as soon as its last listener is in place,
		// so the signal is pending before git is spawned.
		const preload = join(setup.dir, "pending.cjs");
		writeFileSync(
			preload,
			[
				"const on = process.on.bind(process);",
				"process.on = (name, listener) => {",
				"\tconst result = on(name, listener);",
				'\tif (name === "SIGHUP") process.kill(process.pid, "SIGINT");',
				"\treturn result;",
				"};",
			].join("\n"),
		);
		const endings: string[] = [];
		for (let run = 0; run < 10; run += 1) {
			const wrapper = setup.start(`--require ${preload}`);
			const end = await ending(wrapper);
			await pause(100);
			endings.push(
				`${end ?? "still running"}${setup.started() ? ", git started" : ""}`,
			);
			sweep(wrapper, setup);
		}
		assert.deepEqual(endings, Array(10).fill("130"));
	});
});
