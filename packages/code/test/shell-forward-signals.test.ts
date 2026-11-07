import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { constants, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	initStation,
	loadStationEvents,
	PAM_RAIL_CAPABILITY,
	persistStationEvents,
	StationService,
	stationRoot,
} from "@hobo/stations";
import { afterEach, describe, expect, it } from "vitest";

import { type JsonObject, parseJsonObject } from "../src/json.js";
import { testEnv } from "./test-env.js";

// The interactive shell's `/sessions serve --host <machine>` opens a Station
// authorization and runs a forward over it, as `hobo-code session serve
// --host` does. The shell holds the ending signals across it, as the entry
// does: SIGTERM or SIGHUP to hobo-code while the forward runs closes the
// authorization, saying `shell-quit`, stops ssh, and the shell ends by the
// signal. Closing the terminal ends it the same way, as a hangup; a crash of
// the shell still stops ssh. Here the shell runs as a person runs it, under
// util-linux script(1), against a real Station, with a stand-in `ssh` that
// runs until signalled.

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(pkgRoot, "bin", "hobo-code.mjs");
const STATION = "station:local";
const ESC = String.fromCharCode(0x1b);
const SHELL_DRAWN = `${ESC}[?1049h`;
const CONTROL_SEQUENCES = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "gu");
/**
 * A preload for the launcher and hobo-code's work process. In the work
 * process it records its pid and its exit code, and, with CRASH_AFTER, throws
 * an uncaught error once that file exists. With LATE_SIGTERM it hands its
 * process each SIGTERM 300 ms late, as a loaded machine can: the launcher
 * passes the signal on late, and hobo-code hears it only after what else the
 * group signal reached (ssh) has ended.
 */
const PRELOAD = `import fs from "node:fs";
const work = /dist\\/bin\\/hobo-code\\.js$/u.test(process.argv[1] ?? "") && process.argv[2] !== "_station-agent";
if (process.env.LATE_SIGTERM === "1") {
	const emit = process.emit;
	process.emit = function (event, ...rest) {
		if (event !== "SIGTERM") return emit.call(this, event, ...rest);
		setTimeout(() => emit.call(process, event, ...rest), 300);
		return process.listenerCount(event) > 0;
	};
}
if (work) {
	fs.writeFileSync(process.env.WORK_PID, String(process.pid));
	process.on("exit", (code) => fs.writeFileSync(process.env.WORK_EXIT, String(code)));
	const after = process.env.CRASH_AFTER;
	if (after) {
		const wait = setInterval(() => {
			if (!fs.existsSync(after)) return;
			clearInterval(wait);
			setTimeout(() => {
				throw new Error("an uncaught error in hobo-code's shell");
			}, 300);
		}, 100);
	}
}
`;
/** Bounds on a failure, never waits to sit out: each step goes on at its event. */
const STEP_BOUND_MS = 60_000;
/** How long ssh may outlive the shell's work process. */
const SSH_GONE_BOUND_MS = 10_000;
const RUN_TIMEOUT_MS = 4 * STEP_BOUND_MS;

function needsScript(): string | false {
	const probe = spawnSync("script", ["--version"], { encoding: "utf8" });
	if (probe.error !== undefined) return "needs util-linux script(1)";
	return /util-linux/u.test(`${probe.stdout}${probe.stderr}`)
		? false
		: "needs util-linux script(1)";
}
const skipReason = needsScript();

const roots: string[] = [];
const servers: Server[] = [];
const standIns: number[] = [];
afterEach(async () => {
	for (const pid of standIns.splice(0)) {
		if (running(pid)) process.kill(pid, "SIGKILL");
	}
	for (const server of servers.splice(0)) {
		await new Promise((resolve) => server.close(resolve));
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
		await sleep(100);
	}
	return true;
}

function stationWithPam(hoboHome: string): void {
	initStation({ hoboHome, id: STATION, tenant: "acme" });
	const service = StationService.fromEvents(
		loadStationEvents(hoboHome, STATION),
		{ stationId: STATION },
	);
	const rail = service.publishRail({
		id: "rail-pam",
		name: "PAM",
		version: "1.0.0",
		stationId: STATION,
		policyPacks: [PAM_RAIL_CAPABILITY],
	});
	service.approveRail(rail.contentHash);
	service.activateRail(rail.contentHash);
	persistStationEvents(hoboHome, STATION, service.events);
}

/** The Station's audit, as `type` or `type(reason)` for a session's end. */
function audit(hoboHome: string): readonly string[] {
	const path = join(stationRoot(hoboHome, STATION), "pam-audit.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line): JsonObject => parseJsonObject(line))
		.map((event) =>
			event.type === "pam.SessionEnded"
				? `${String(event.type)}(${String(event.reason)})`
				: String(event.type),
		);
}

interface Ended {
	/** hobo-code's status, as the terminal's shell saw it. */
	readonly code: number | null;
	/** The work process's exit code, as its 'exit' saw it; null without one. */
	readonly workExit: number | null;
	readonly audit: readonly string[];
	readonly sshEnded: boolean;
	readonly sockets: readonly string[];
	readonly screen: string;
}

/** How each case ends the shell once its forward's ssh runs. */
type Ending =
	| "SIGTERM"
	| "SIGHUP"
	/** script(1) is killed: the pseudo-terminal goes, as when its window closes. */
	| "close the terminal"
	/** An uncaught error in hobo-code's work process. */
	| "crash"
	/** SIGKILL to hobo-code's work process, which no handler sees. */
	| "SIGKILL the work process";

/**
 * Start hobo-code's shell, run `/sessions serve --host box` in it, and once
 * the stand-in ssh runs, end it as `ending` says.
 */
async function forwardInShellThenEnd(
	ending: Ending,
	options: { readonly lateSignal?: boolean } = {},
): Promise<Ended> {
	// Short paths: the Station's agent proxy is a Unix socket under HOBO_HOME.
	const root = mkdtempSync(join(tmpdir(), "z"));
	roots.push(root);
	const at = (name: string): string => join(root, name);
	const hoboHome = at("h");
	const project = at("p");
	const bin = at("b");
	const tmp = at("t");
	const tmux = at("x");
	for (const dir of [project, bin, tmp, tmux]) mkdirSync(dir);
	stationWithPam(hoboHome);
	writeFileSync(
		join(project, "devenv.machines.json"),
		`${JSON.stringify({
			machines: [
				{ id: "box", host: "box.ts.net", isolationClass: "development" },
			],
		})}\n`,
	);
	writeFileSync(
		join(bin, "ssh"),
		`#!/bin/sh\necho $$ > '${at("ssh.pid")}'\nwhile :; do sleep 0.1; done\n`,
	);
	chmodSync(join(bin, "ssh"), 0o755);
	writeFileSync(at("preload.mjs"), PRELOAD);
	const agentSocket = at("a.sock");
	const agent = createServer((socket) => socket.end());
	servers.push(agent);
	await new Promise<void>((resolve) => agent.listen(agentSocket, resolve));
	const command = [
		"stty cols 120 rows 40",
		`sh -c "echo \\$\\$ > '${at("pid")}'; exec '${process.execPath}' '${launcher}'"`,
		`echo $? > '${at("status")}'`,
		`while [ ! -e '${at("done")}' ]; do sleep 0.1; done`,
	].join("; ");
	const script = spawn("script", ["-qfec", command, "/dev/null"], {
		cwd: project,
		env: testEnv({
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			HOME: root,
			HOBO_HOME: hoboHome,
			TMPDIR: tmp,
			TMUX_TMPDIR: tmux,
			SSH_AUTH_SOCK: agentSocket,
			TERM: "xterm-256color",
			HOBO_CODE_ENGINE: "none",
			HOBO_CODE_FROM_SOURCE: "0",
			HOBO_CODE_SKIP_STALE_REBUILD: "1",
			HOBO_CODE_REDUCED_MOTION: "1",
			HOBO_CODE_SIDECAR_POLL_MS: "250",
			NODE_NO_WARNINGS: "1",
			NODE_OPTIONS: `--import=${pathToFileURL(at("preload.mjs")).href}`,
			WORK_PID: at("work.pid"),
			WORK_EXIT: at("work.exit"),
			LATE_SIGTERM: options.lateSignal === true ? "1" : "0",
			CRASH_AFTER: ending === "crash" ? at("ssh.pid") : "",
		}),
		stdio: ["pipe", "pipe", "pipe"],
	});
	let screen = "";
	const draw = (chunk: Buffer): void => {
		screen = `${screen}${chunk.toString("utf8")}`.slice(-64 * 1024);
	};
	script.stdout.on("data", draw);
	script.stderr.on("data", draw);
	let closed = false;
	script.once("close", () => {
		closed = true;
	});
	const sockets = (): readonly string[] => {
		const dir = join(stationRoot(hoboHome, STATION), "ssh-agent");
		return existsSync(dir) ? readdirSync(dir) : [];
	};
	try {
		if (
			!(await until(
				() => closed || screen.includes(SHELL_DRAWN),
				STEP_BOUND_MS,
			))
		)
			throw new Error(
				`the shell never drew:\n${screen.replace(CONTROL_SEQUENCES, "").slice(-2000)}`,
			);
		script.stdin.write(
			`/sessions serve --host box --port 4242 --station ${STATION}`,
		);
		await sleep(500);
		script.stdin.write("\r");
		if (!(await until(() => existsSync(at("ssh.pid")), STEP_BOUND_MS)))
			throw new Error(
				`ssh never started:\n${screen.replace(CONTROL_SEQUENCES, "").slice(-2000)}`,
			);
		const ssh = Number(readFileSync(at("ssh.pid"), "utf8"));
		standIns.push(ssh);
		const work = Number(readFileSync(at("work.pid"), "utf8"));
		standIns.push(work);
		if (ending === "SIGTERM" || ending === "SIGHUP")
			process.kill(Number(readFileSync(at("pid"), "utf8")), ending);
		if (ending === "close the terminal") script.kill("SIGKILL");
		if (ending === "SIGKILL the work process") process.kill(work, "SIGKILL");
		await until(() => !running(work), STEP_BOUND_MS);
		await until(() => existsSync(at("status")) || closed, STEP_BOUND_MS);
		// Bounded: what ends ssh acts as the shell goes, not at a lease.
		await until(() => !running(ssh), SSH_GONE_BOUND_MS);
		return {
			code: existsSync(at("status"))
				? Number(readFileSync(at("status"), "utf8").trim())
				: null,
			workExit: existsSync(at("work.exit"))
				? Number(readFileSync(at("work.exit"), "utf8"))
				: null,
			audit: audit(hoboHome),
			sshEnded: !running(ssh),
			sockets: sockets(),
			screen: screen.replace(CONTROL_SEQUENCES, ""),
		};
	} finally {
		writeFileSync(at("done"), "");
		if (!(await until(() => closed, STEP_BOUND_MS))) script.kill("SIGKILL");
		spawnSync("tmux", ["kill-server"], {
			env: { PATH: process.env.PATH ?? "", TMUX_TMPDIR: tmux },
			stdio: "ignore",
		});
	}
}

describe.skipIf(skipReason !== false)(
	"hobo-code's shell, signalled while its /sessions serve --host forward runs",
	() => {
		for (const signal of ["SIGTERM", "SIGHUP"] as const) {
			it(
				`${signal}: closes the authorization saying shell-quit, stops ssh, and ends by the signal`,
				async () => {
					const ended = await forwardInShellThenEnd(signal);
					expect(ended.audit, ended.screen.slice(-2000)).toEqual([
						"pam.GatewayStarted",
						"pam.SessionStarted",
						"pam.SessionEnded(shell-quit)",
						"pam.GatewayStopped",
					]);
					expect(ended.sshEnded).toBe(true);
					expect(ended.sockets).toEqual([]);
					expect(ended.code).toBe(128 + constants.signals[signal]);
				},
				RUN_TIMEOUT_MS,
			);
		}

		it(
			"SIGTERM that hobo-code hears only once the group signal has ended ssh: still shell-quit, and ends by the signal",
			async () => {
				const ended = await forwardInShellThenEnd("SIGTERM", {
					lateSignal: true,
				});
				expect(ended.audit, ended.screen.slice(-2000)).toEqual([
					"pam.GatewayStarted",
					"pam.SessionStarted",
					"pam.SessionEnded(shell-quit)",
					"pam.GatewayStopped",
				]);
				expect(ended.sshEnded).toBe(true);
				expect(ended.sockets).toEqual([]);
				expect(ended.code).toBe(128 + constants.signals.SIGTERM);
			},
			RUN_TIMEOUT_MS,
		);
	},
);

describe.skipIf(skipReason !== false)(
	"hobo-code's shell, its terminal or its process gone while its /sessions serve --host forward runs",
	() => {
		it(
			"the terminal closed: a hangup, which closes the authorization saying shell-quit, stops ssh, and ends hobo-code with 129",
			async () => {
				const ended = await forwardInShellThenEnd("close the terminal");
				expect(ended.audit, ended.screen.slice(-2000)).toEqual([
					"pam.GatewayStarted",
					"pam.SessionStarted",
					"pam.SessionEnded(shell-quit)",
					"pam.GatewayStopped",
				]);
				expect(ended.sshEnded).toBe(true);
				expect(ended.sockets).toEqual([]);
				expect(ended.workExit).toBe(128 + constants.signals.SIGHUP);
			},
			RUN_TIMEOUT_MS,
		);

		it(
			"SIGKILL to the shell's process: ssh does not outlive it",
			async () => {
				// The watchdog ssh runs under sees the shell's pipe end. Nothing
				// can close the authorization after SIGKILL; its lease ends it.
				const ended = await forwardInShellThenEnd("SIGKILL the work process");
				expect(ended.workExit, ended.screen.slice(-2000)).toBeNull();
				expect(ended.sshEnded).toBe(true);
			},
			RUN_TIMEOUT_MS,
		);

		it(
			"an uncaught error in the shell: ssh does not outlive it",
			async () => {
				// Nothing can close the authorization from a crash; its lease ends it.
				const ended = await forwardInShellThenEnd("crash");
				expect(ended.workExit, ended.screen.slice(-2000)).not.toBe(0);
				expect(ended.sshEnded).toBe(true);
			},
			RUN_TIMEOUT_MS,
		);
	},
);
