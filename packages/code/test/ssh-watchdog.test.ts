import { type ChildProcess, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { testEnv } from "./test-env.js";

// The interactive shell runs its forward's ssh detached, under a watchdog
// (bin/ssh-watchdog.mjs) whose stdin is a pipe the shell's process holds. The
// watchdog ends ssh's process group when that pipe ends, however the shell's
// process ended, and at the authorization's lease. Here a stand-in for ssh,
// which starts a child in its group, runs under the real watchdog.

const WATCHDOG = fileURLToPath(
	new URL("../bin/ssh-watchdog.mjs", import.meta.url),
);

const roots: string[] = [];
const pids: number[] = [];
const watchdogs: ChildProcess[] = [];
afterEach(() => {
	for (const watchdog of watchdogs.splice(0)) {
		if (watchdog.exitCode === null && watchdog.signalCode === null)
			watchdog.kill("SIGKILL");
	}
	for (const pid of pids.splice(0)) {
		if (running(pid)) process.kill(pid, "SIGKILL");
	}
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function running(pid: number): boolean {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
	} catch {
		return false;
	}
}

async function until(done: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (!done()) {
		if (Date.now() > deadline) return false;
		await sleep(50);
	}
	return true;
}

interface Watched {
	readonly watchdog: ChildProcess;
	/** The stand-in ssh and the child it started in its group, by pid. */
	readonly ssh: number;
	readonly child: number;
	readonly ended: Promise<[number | null, NodeJS.Signals | null]>;
}

/**
 * Run a stand-in ssh under the watchdog, with the lease at `leaseMs` from now.
 * `trapTerm` makes the stand-in ignore SIGTERM; `exitWith` makes it exit.
 */
async function watch(
	options: {
		readonly leaseMs?: number;
		readonly trapTerm?: boolean;
		readonly exitWith?: number;
	} = {},
): Promise<Watched> {
	const root = mkdtempSync(join(tmpdir(), "w"));
	roots.push(root);
	const standIn = join(root, "ssh");
	writeFileSync(
		standIn,
		options.exitWith !== undefined
			? `#!/bin/sh\nexit ${options.exitWith}\n`
			: [
					"#!/bin/sh",
					options.trapTerm === true ? "trap '' TERM" : "",
					`sleep 600 & echo $! > '${join(root, "child.pid")}'`,
					`echo $$ > '${join(root, "ssh.pid")}'`,
					"while :; do sleep 0.1; done",
					"",
				].join("\n"),
	);
	chmodSync(standIn, 0o755);
	const watchdog = spawn(
		process.execPath,
		[
			WATCHDOG,
			String(Date.now() + (options.leaseMs ?? 3_600_000)),
			standIn,
			"-N",
		],
		{
			stdio: ["pipe", "ignore", "ignore"],
			env: testEnv({ PATH: process.env.PATH ?? "" }),
		},
	);
	watchdogs.push(watchdog);
	const ended = new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
		watchdog.once("exit", (code, signal) => resolve([code, signal])),
	);
	if (options.exitWith !== undefined)
		return { watchdog, ssh: -1, child: -1, ended };
	await until(
		() =>
			existsSync(join(root, "ssh.pid")) && existsSync(join(root, "child.pid")),
		10_000,
	);
	const ssh = Number(readFileSync(join(root, "ssh.pid"), "utf8"));
	const child = Number(readFileSync(join(root, "child.pid"), "utf8"));
	pids.push(ssh, child);
	return { watchdog, ssh, child, ended };
}

describe("the shell's ssh watchdog", () => {
	it("ends ssh's process group when the shell's end of its pipe closes", async () => {
		const watched = await watch();
		expect(running(watched.ssh)).toBe(true);
		watched.watchdog.stdin?.end();
		expect(await until(() => !running(watched.ssh), 5_000)).toBe(true);
		expect(await until(() => !running(watched.child), 5_000)).toBe(true);
		expect(await watched.ended).toEqual([null, "SIGTERM"]);
	}, 30_000);

	it("ends it at the lease, while the shell still holds its pipe", async () => {
		const watched = await watch({ leaseMs: 1_500 });
		expect(running(watched.ssh)).toBe(true);
		expect(await until(() => !running(watched.ssh), 8_000)).toBe(true);
		expect(await until(() => !running(watched.child), 5_000)).toBe(true);
		expect(await watched.ended).toEqual([null, "SIGTERM"]);
	}, 30_000);

	it("passes the shell's stop on to ssh's group, and ends by ssh's signal", async () => {
		const watched = await watch();
		watched.watchdog.kill("SIGHUP");
		expect(await watched.ended).toEqual([null, "SIGHUP"]);
		expect(await until(() => !running(watched.child), 5_000)).toBe(true);
	}, 30_000);

	it("kills a group that ignores the stop once its grace is over", async () => {
		const watched = await watch({ trapTerm: true });
		watched.watchdog.stdin?.end();
		const ended = await watched.ended;
		expect(ended).toEqual([null, "SIGKILL"]);
		expect(running(watched.ssh)).toBe(false);
	}, 30_000);

	it("ends with ssh's status when ssh ends by itself", async () => {
		const watched = await watch({ exitWith: 3 });
		expect(await watched.ended).toEqual([3, null]);
	}, 30_000);
});
