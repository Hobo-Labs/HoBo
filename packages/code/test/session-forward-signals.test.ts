import { spawn } from "node:child_process";
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
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
	initStation,
	loadStationEvents,
	PAM_RAIL_CAPABILITY,
	persistStationEvents,
	StationService,
	stationRoot,
} from "@hobo/stations";
import { afterEach, describe, expect, it } from "vitest";

import { isJsonString, parseJsonObject } from "../src/json.js";
import { testEnv } from "./test-env.js";

// `hobo-code session serve --host <machine>` forwards a resident browser over
// SSH under a Station authorization, and closes that authorization when the
// forward ends. However hobo-code is ended, it must close it, and its ssh
// must not outlive it. Here the Station is real, the machine is declared, and
// `ssh` is a stand-in on PATH that runs until it is told to stop.

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(pkgRoot, "bin", "hobo-code.mjs");
const STATION = "station:local";
const FORWARD_DEADLINE_MS = 120_000;
const END_GRACE_MS = 30_000;

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

/** The process exists and is not a zombie. */
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

/** A local Station whose active Rail enables privileged access. */
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

interface Forwarded {
	readonly forwarded: boolean;
	/** hobo-code's status, 128+n when it ended by signal n. */
	readonly code: number | null;
	/** The Station's durable audit types, in order. */
	readonly audit: readonly string[];
	/** Whether the stand-in `ssh` ever started. */
	readonly sshRan: boolean;
	/** The stand-in's TMUX_TMPDIR and HOBO_CODE_SEAT_AGENTS, space-separated. */
	readonly sshEnv: string;
	/** No stand-in `ssh` is left running. */
	readonly standInEnded: boolean;
	readonly output: string;
}

/** The pids of stand-in `ssh` processes still running: `sh <path>` and its children. */
function standInsRunning(ssh: string): number[] {
	return readdirSync("/proc")
		.filter((name) => /^\d+$/u.test(name))
		.map(Number)
		.filter((pid) => {
			try {
				return (
					readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(ssh) &&
					running(pid)
				);
			} catch {
				return false;
			}
		});
}

/**
 * CommonJS preloads (NODE_OPTIONS=--require) that widen one window of
 * hobo-code's, and write PROBE_MARKER when it opens, so a case signals inside
 * it on that event rather than after a guess at a delay.
 */
const PRELOADS = {
	/** The Station authorization is open, and runHoboCodeCli has not returned. */
	"authorization opening": `const fs = require("node:fs"); const { syncBuiltinESMExports } = require("node:module"); const append = fs.appendFileSync; fs.appendFileSync = function (path, data, ...rest) { const result = append.call(this, path, data, ...rest); if (String(path).endsWith("pam-audit.jsonl") && String(data).includes("pam.SessionStarted")) { fs.writeFileSync(process.env.PROBE_MARKER, ""); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); } return result; }; syncBuiltinESMExports();`,
	/** The browser address is out, and ssh is being started. */
	"ssh starting": `const cp = require("node:child_process"); const fs = require("node:fs"); const { syncBuiltinESMExports } = require("node:module"); const spawn = cp.spawn; cp.spawn = function (command, ...rest) { if (command === "ssh") { fs.writeFileSync(process.env.PROBE_MARKER, ""); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); } return spawn.call(this, command, ...rest); }; syncBuiltinESMExports();`,
	/** ssh has ended, and the authorization is being closed. */
	"authorization closing": `const net = require("node:net"); const fs = require("node:fs"); const close = net.Server.prototype.close; net.Server.prototype.close = function (callback) { fs.writeFileSync(process.env.PROBE_MARKER, ""); return close.call(this, (...args) => setTimeout(() => callback?.(...args), 1500)); };`,
} as const;
type Window = keyof typeof PRELOADS;

interface Ending {
	/**
	 * What ends hobo-code: one of its signals, the stand-in ssh exiting, or
	 * SIGKILL to the launcher, which passes nothing on: hobo-code then hangs
	 * up on itself.
	 */
	readonly by: NodeJS.Signals | "ssh ends" | "the launcher killed";
	/** A stand-in ssh that ignores the four ending signals, until SIGKILL. */
	readonly stubbornSsh?: boolean;
	/** Send the signal inside this window rather than once ssh runs. */
	readonly inside?: Window;
	/** Send the same signal again inside this window, after the first. */
	readonly againInside?: Window;
}

/**
 * Start the forward, and end it as `ending` says: by default, once the
 * stand-in `ssh` runs, send hobo-code `ending.by`, or let the stand-in exit
 * by itself.
 */
async function forwardThenEnd(ending: Ending): Promise<Forwarded> {
	// Short paths: the Station's agent proxy is a Unix socket under HOBO_HOME.
	const root = mkdtempSync(join(tmpdir(), "f"));
	roots.push(root);
	const hoboHome = join(root, "h");
	const project = join(root, "p");
	const bin = join(root, "bin");
	mkdirSync(project);
	mkdirSync(bin);
	stationWithPam(hoboHome);
	writeFileSync(
		join(project, "devenv.machines.json"),
		`${JSON.stringify({
			machines: [
				{ id: "box", host: "box.ts.net", isolationClass: "development" },
			],
		})}\n`,
	);
	// The upstream agent the Station's lease-bound proxy fronts.
	const agentSocket = join(root, "a.sock");
	const agent = createServer((socket) => socket.end());
	servers.push(agent);
	await new Promise<void>((resolve) => agent.listen(agentSocket, resolve));
	const ssh = join(bin, "ssh");
	const pidFile = join(root, "ssh.pid");
	const release = join(root, "ssh.release");
	const envFile = join(root, "ssh.env");
	writeFileSync(
		ssh,
		`#!/bin/sh\n${ending.stubbornSsh === true ? "trap '' INT TERM HUP QUIT\n" : ""}printf '%s %s' "$TMUX_TMPDIR" "$HOBO_CODE_SEAT_AGENTS" > '${envFile}'\necho $$ > '${pidFile}'\nwhile [ ! -e '${release}' ]; do sleep 0.1; done\nexit 0\n`,
	);
	chmodSync(ssh, 0o755);
	const marker = join(root, "window");
	const windowOf = (window: Window | undefined): string | undefined => {
		if (window === undefined) return undefined;
		const preload = join(root, `${window.replace(/ /gu, "-")}.cjs`);
		writeFileSync(preload, PRELOADS[window]);
		return preload;
	};
	const preloads = [windowOf(ending.inside), windowOf(ending.againInside)]
		.filter((preload) => preload !== undefined)
		.map((preload) => `--require ${preload}`);

	const run = spawn(
		process.execPath,
		[
			launcher,
			"session",
			"serve",
			"--host",
			"box",
			"--port",
			"4242",
			"--station",
			STATION,
		],
		{
			cwd: project,
			env: testEnv({
				PATH: `${bin}:${process.env.PATH ?? ""}`,
				HOME: root,
				HOBO_HOME: hoboHome,
				TMPDIR: root,
				SSH_AUTH_SOCK: agentSocket,
				HOBO_CODE_FROM_SOURCE: "0",
				HOBO_CODE_SKIP_STALE_REBUILD: "1",
				NODE_NO_WARNINGS: "1",
				PROBE_MARKER: marker,
				...(preloads.length > 0
					? { NODE_OPTIONS: preloads.join(" ") }
					: undefined),
			}),
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let output = "";
	run.stdout.on("data", (chunk) => {
		output = `${output}${chunk}`;
	});
	run.stderr.on("data", (chunk) => {
		output = `${output}${chunk}`;
	});
	let code: number | null = null;
	let closed = false;
	run.once("close", (status, signal) => {
		code = status ?? (signal === null ? null : -1);
		closed = true;
	});
	const inWindow = (): boolean => existsSync(marker);
	const sshRuns = (): boolean =>
		/^browser: /mu.test(output) && existsSync(pidFile);
	const forwarded = await until(
		() => closed || (ending.inside !== undefined ? inWindow() : sshRuns()),
		FORWARD_DEADLINE_MS,
	);
	if (forwarded && !closed) {
		if (ending.by === "ssh ends") writeFileSync(release, "");
		else if (ending.by === "the launcher killed") run.kill("SIGKILL");
		else {
			// The second window opens only after the first signal.
			rmSync(marker, { force: true });
			run.kill(ending.by);
			if (
				ending.againInside !== undefined &&
				(await until(() => closed || inWindow(), END_GRACE_MS))
			)
				run.kill(ending.by);
		}
	}
	if (!(await until(() => closed, END_GRACE_MS))) run.kill("SIGKILL");
	await until(() => closed, END_GRACE_MS);
	const auditPath = join(stationRoot(hoboHome, STATION), "pam-audit.jsonl");
	const audit = existsSync(auditPath)
		? readFileSync(auditPath, "utf8")
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => {
					const type = parseJsonObject(line).type;
					return isJsonString(type) ? type : "";
				})
		: [];
	const left = standInsRunning(ssh);
	standIns.push(...left);
	return {
		forwarded,
		code,
		audit,
		sshRan: existsSync(pidFile),
		sshEnv: existsSync(envFile) ? readFileSync(envFile, "utf8") : "",
		standInEnded: left.length === 0,
		output,
	};
}

describe.skipIf(process.platform !== "linux")(
	"hobo-code forwarding a resident browser, ended",
	() => {
		// The status each ending gives hobo-code: 128+n for signal n. The
		// launcher reports the same when a signal kills hobo-code outright, and
		// the launcher's group signal ends this ssh too, so these alone do not
		// show that the forward stopped ssh: the last two cases end hobo-code
		// where nothing but the forward can.
		for (const [by, status] of [
			["SIGINT", 130],
			["SIGTERM", 143],
			["SIGHUP", 129],
			["SIGQUIT", 131],
			["ssh ends", 0],
		] as const) {
			it(
				`by ${by}: closes the Station authorization, ssh is gone, and the status is ${status}`,
				async () => {
					const ended = await forwardThenEnd({ by });
					expect(ended.forwarded, ended.output).toBe(true);
					expect(ended.audit, ended.output).toContain("pam.SessionStarted");
					expect(ended.audit, ended.output).toContain("pam.SessionEnded");
					expect(ended.standInEnded).toBe(true);
					expect(ended.code, ended.output).toBe(status);
					// What hobo-code started reached this file's tmux, not the
					// developer's, and would seat no agents there.
					expect(ended.sshEnv).toBe(`${process.env.TMUX_TMPDIR} 0`);
				},
				FORWARD_DEADLINE_MS + 3 * END_GRACE_MS,
			);
		}

		it(
			"by SIGKILL to the launcher, which passes nothing on: hobo-code hangs up on itself, stops ssh, and closes the authorization",
			async () => {
				// ssh is in hobo-code's process group, which nothing signals here:
				// only the forward can stop it.
				const ended = await forwardThenEnd({ by: "the launcher killed" });
				expect(ended.forwarded, ended.output).toBe(true);
				expect(ended.audit, ended.output).toContain("pam.SessionEnded");
				expect(ended.standInEnded).toBe(true);
			},
			FORWARD_DEADLINE_MS + 3 * END_GRACE_MS,
		);

		it(
			"by SIGTERM, with an ssh that ignores it: ssh is killed 5 s on, and the authorization closed",
			async () => {
				const ended = await forwardThenEnd({
					by: "SIGTERM",
					stubbornSsh: true,
				});
				expect(ended.forwarded, ended.output).toBe(true);
				expect(ended.audit, ended.output).toContain("pam.SessionEnded");
				expect(ended.standInEnded).toBe(true);
				expect(ended.code, ended.output).toBe(143);
			},
			FORWARD_DEADLINE_MS + 3 * END_GRACE_MS,
		);
	},
);

describe.skipIf(process.platform !== "linux")(
	"hobo-code forwarding a resident browser, signalled before the forward listened",
	() => {
		// Node acts on a signal only while something listens for it; otherwise
		// its default action ends the process where it stands. Each window is
		// widened by a preload, and the signal sent inside it.
		it(
			"while the authorization is opened: it is closed, and ssh never starts",
			async () => {
				const ended = await forwardThenEnd({
					by: "SIGTERM",
					inside: "authorization opening",
				});
				expect(ended.forwarded, ended.output).toBe(true);
				expect(ended.audit, ended.output).toContain("pam.SessionEnded");
				expect(ended.code, ended.output).toBe(143);
				expect(ended.output).not.toMatch(/^browser: /mu);
				expect(ended.sshRan).toBe(false);
			},
			FORWARD_DEADLINE_MS + 3 * END_GRACE_MS,
		);

		it(
			"while ssh is started, its address already out: ssh is stopped, and the authorization closed",
			async () => {
				const ended = await forwardThenEnd({
					by: "SIGTERM",
					inside: "ssh starting",
				});
				expect(ended.forwarded, ended.output).toBe(true);
				expect(ended.audit, ended.output).toContain("pam.SessionEnded");
				expect(ended.code, ended.output).toBe(143);
				expect(ended.standInEnded).toBe(true);
			},
			FORWARD_DEADLINE_MS + 3 * END_GRACE_MS,
		);
	},
);

describe.skipIf(process.platform !== "linux")(
	"hobo-code forwarding a resident browser, signalled again while it closes the authorization",
	() => {
		// ssh is gone and the authorization is being closed (widened by a
		// preload): a second signal must wait for that, not end hobo-code
		// before pam.SessionEnded is written.
		it(
			"is held until the authorization is closed",
			async () => {
				const ended = await forwardThenEnd({
					by: "SIGINT",
					againInside: "authorization closing",
				});
				expect(ended.forwarded, ended.output).toBe(true);
				expect(ended.audit, ended.output).toContain("pam.SessionEnded");
				expect(ended.code, ended.output).toBe(130);
				expect(ended.standInEnded).toBe(true);
			},
			FORWARD_DEADLINE_MS + 3 * END_GRACE_MS,
		);
	},
);
