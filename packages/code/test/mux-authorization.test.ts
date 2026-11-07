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
import { tmpdir } from "node:os";
import { join } from "node:path";
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

import { type HoboCodeCliResult, runHoboCodeCli } from "../src/cli.js";
import {
	isJsonObject,
	type JsonObject,
	parseJsonObject,
	parseJsonValue,
} from "../src/json.js";
import {
	type OpenedGateway,
	openStationGateway,
	type ResolvedSshIdentity,
} from "../src/machine-sessions.js";
import type { MuxRunner } from "../src/mux.js";
import { testEnv } from "./test-env.js";

// `hobo-code mux --host <machine>` brokers a Station session per pane and
// hands each to a resident SSH-agent proxy, a detached `_station-agent`
// process that holds the lease. Only the proxies of the panes mux created
// stay; however mux ends otherwise, every proxy it handed off is stopped, so
// it writes its pam.SessionEnded, and none outlives it.

const STATION = "station:local";
/** Starts a proxy without loading the whole CLI first (see the file). */
const ENTRY = fileURLToPath(
	new URL("./fixtures/hobo-code-entry.mjs", import.meta.url),
);

const roots: string[] = [];
const servers: Server[] = [];
const identities: ResolvedSshIdentity[] = [];
afterEach(async () => {
	tmux(["kill-session", "-t", `=${SESSION}`]);
	tmux(["kill-session", "-t", "=mine"]);
	for (const identity of identities.splice(0)) await identity.stop();
	for (const server of servers.splice(0)) {
		await new Promise((resolve) => server.close(resolve));
	}
	for (const root of roots.splice(0)) {
		for (const pid of proxiesUnder(root)) process.kill(pid, "SIGKILL");
		rmSync(root, { recursive: true, force: true });
	}
});

/** The tmux session mux opens here, `--session t`. */
const SESSION = "t";

/** tmux on this test file's own server (test/isolate-tmux.ts); its status. */
function tmux(args: readonly string[]): number | null {
	return spawnSync("tmux", [...args], { stdio: "ignore" }).status;
}

/** The windows of the session named exactly `session`, by name. */
function windowsOf(session: string): readonly string[] {
	const listed = spawnSync(
		"tmux",
		["list-windows", "-t", `=${session}:`, "-F", "#{window_name}"],
		{ encoding: "utf8" },
	);
	return listed.status === 0
		? listed.stdout.split("\n").filter((line) => line.length > 0)
		: [];
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

/** The resident proxies running for sockets under `root`, by pid. */
function proxiesUnder(root: string): number[] {
	return readdirSync("/proc")
		.filter((name) => /^\d+$/u.test(name))
		.map(Number)
		.filter((pid) => {
			try {
				const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
				if (argv[2] !== "_station-agent") return false;
				const payload = parseJsonValue(
					Buffer.from(argv[3] ?? "", "base64url").toString("utf8"),
				);
				return (
					isJsonObject(payload) && String(payload.socketPath).startsWith(root)
				);
			} catch {
				return false;
			}
		});
}

/**
 * A local Station with a PAM Rail, a declared machine `box`, an upstream SSH
 * agent, and stand-ins on PATH: a `codex` to place, and an `ssh` that exits.
 */
async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "m"));
	roots.push(root);
	const hoboHome = join(root, "h");
	const project = join(root, "p");
	const bin = join(root, "b");
	const home = join(root, "u");
	for (const dir of [project, bin, home]) mkdirSync(dir);
	stationWithPam(hoboHome);
	writeFileSync(
		join(project, "devenv.machines.json"),
		`${JSON.stringify({
			machines: [
				{ id: "box", host: "box.ts.net", isolationClass: "development" },
			],
		})}\n`,
	);
	for (const name of ["codex", "ssh"]) {
		writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
		chmodSync(join(bin, name), 0o755);
	}
	const agentSocket = join(root, "a.sock");
	const agent = createServer((socket) => socket.end());
	servers.push(agent);
	await new Promise<void>((resolve) => agent.listen(agentSocket, resolve));
	const sockets = (): readonly string[] => {
		const dir = join(stationRoot(hoboHome, STATION), "ssh-agent");
		return existsSync(dir) ? readdirSync(dir) : [];
	};
	return { root, hoboHome, project, bin, home, agentSocket, sockets };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

interface Muxed {
	readonly result?: HoboCodeCliResult;
	readonly error?: unknown;
	readonly handedOff: number;
}

/** Run `mux --host box` in process, its gateway changed by `alter`. */
async function mux(
	f: Fixture,
	alter: (gateway: OpenedGateway) => OpenedGateway,
	muxRunner: MuxRunner = {
		run: async () => {
			throw new Error("tmux is not reached here");
		},
	},
	proxyEntry: string = ENTRY,
): Promise<Muxed> {
	// The proxy is started as `process.argv[1] _station-agent …`.
	const entry = process.argv[1] ?? "";
	process.argv[1] = proxyEntry;
	let handedOff = 0;
	try {
		const result = await runHoboCodeCli(
			["mux", "--host", "box", "--station", STATION, "--session", "t"],
			{
				hoboHome: f.hoboHome,
				cwd: f.project,
				env: {
					PATH: `${f.bin}:/usr/bin:/bin`,
					HOME: f.home,
					HOBO_HOME: f.hoboHome,
					HOBO_CODE_SEAT_AGENTS: "1",
				},
				openStationGateway: async (context) => {
					const altered = alter(
						await openStationGateway({
							...context,
							sshAuthSock: f.agentSocket,
						}),
					);
					return {
						...altered,
						handoffSshIdentity: async (pane) => {
							const identity = await altered.handoffSshIdentity(pane);
							identities.push(identity);
							handedOff += 1;
							return identity;
						},
					};
				},
				muxRunner,
			},
		);
		return { result, handedOff };
	} catch (error) {
		return { error, handedOff };
	} finally {
		process.argv[1] = entry;
	}
}

describe("mux --host, ending before its panes hold the leases", () => {
	it("stops the proxy it handed off when closing the gateway fails", async () => {
		const f = await fixture();
		const muxed = await mux(f, (gateway) => ({
			...gateway,
			close: async (reason) => {
				await gateway.close(reason);
				throw new Error("audit sink EIO while closing");
			},
		}));
		expect(muxed.handedOff).toBe(1);
		expect(muxed.error).toBeUndefined();
		expect(muxed.result?.code).toBe("HOBO_CODE_MUX_AUTHORIZATION_FAILED");
		expect(muxed.result?.message).toContain("audit sink EIO while closing");
		expect(audit(f.hoboHome)).toEqual([
			"pam.GatewayStarted",
			"pam.SessionStarted",
			"pam.GatewayStopped",
			"pam.SessionEnded(launcher-stop)",
		]);
		expect(proxiesUnder(f.root)).toEqual([]);
		expect(f.sockets()).toEqual([]);
	}, 60_000);

	it("answers a proxy that fails to start with a failure, not a crash, and ends the session", async () => {
		// The proxy's own process exits at once: its socket never opens.
		const f = await fixture();
		const broken = join(f.root, "exits.mjs");
		writeFileSync(broken, "process.exit(3);\n");
		const muxed = await mux(f, (gateway) => gateway, undefined, broken);
		expect(muxed.error).toBeUndefined();
		expect(muxed.result?.code).toBe("HOBO_CODE_MUX_AUTHORIZATION_FAILED");
		expect(muxed.result?.message).toContain(
			"resident SSH agent exited before opening its socket",
		);
		expect(audit(f.hoboHome)).toEqual([
			"pam.GatewayStarted",
			"pam.SessionStarted",
			"pam.SessionEnded(agent-proxy-start-failed)",
			"pam.GatewayStopped",
		]);
		expect(proxiesUnder(f.root)).toEqual([]);
	}, 60_000);
});

/**
 * A preload that sends this process `SIGTERM` at one point of mux: right
 * after pam.SessionStarted is written, as the first tmux command is started
 * (by then a pane's session is with its proxy), or once `tmux new-session`
 * has exited, after running SIGNAL_HOOK, what another tmux client does then.
 */
const SIGNAL_AT = `import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const at = process.env.SIGNAL_AT;
let sent = false;
const send = () => {
	if (sent) return;
	sent = true;
	process.kill(process.pid, "SIGTERM");
};
const append = fs.appendFileSync;
fs.appendFileSync = function (path, data, ...rest) {
	const result = append.call(this, path, data, ...rest);
	if (at === "session started" && String(path).endsWith("pam-audit.jsonl") && String(data).includes('"pam.SessionStarted"')) send();
	return result;
};
const start = cp.spawn;
const runHook = cp.spawnSync;
cp.spawn = function (command, args, ...rest) {
	if (at === "tmux" && command === "tmux") send();
	const child = start.call(this, command, args, ...rest);
	if (at === "after new-session" && command === "tmux" && Array.isArray(args) && args.includes("new-session")) {
		child.once("exit", () => {
			if (process.env.SIGNAL_HOOK) runHook("sh", ["-c", process.env.SIGNAL_HOOK], { stdio: "ignore", env: process.env });
			send();
		});
	}
	return child;
};
syncBuiltinESMExports();
`;

interface Ended {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly output: string;
}

/** Run hobo-code's `mux --host box` as a process, signalled at `at`. */
async function muxSignalled(
	f: Fixture,
	at: "session started" | "tmux" | "after new-session",
	hook = "",
): Promise<Ended> {
	const preload = join(f.root, "signal-at.mjs");
	writeFileSync(preload, SIGNAL_AT);
	const run = spawn(
		process.execPath,
		[
			"--import",
			preload,
			ENTRY,
			"mux",
			"--host",
			"box",
			"--station",
			STATION,
			"--session",
			"t",
		],
		{
			cwd: f.project,
			env: {
				...testEnv({
					PATH: `${f.bin}:/usr/bin:/bin`,
					HOME: f.home,
					HOBO_HOME: f.hoboHome,
					TMPDIR: tmpdir(),
					SSH_AUTH_SOCK: f.agentSocket,
					NODE_NO_WARNINGS: "1",
					SIGNAL_AT: at,
					SIGNAL_HOOK: hook,
				}),
				// mux places agents only when seating is on.
				HOBO_CODE_SEAT_AGENTS: "1",
			},
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
	const [code, signal] = await new Promise<
		[number | null, NodeJS.Signals | null]
	>((resolve) => run.once("close", (c, s) => resolve([c, s])));
	return { code, signal, output };
}

describe("mux --host, signalled before its panes hold the leases", () => {
	it("right after a session starts: ends it, closes the gateway, and ends by the signal", async () => {
		const f = await fixture();
		const ended = await muxSignalled(f, "session started");
		expect(ended.signal, ended.output).toBeNull();
		expect(ended.code, ended.output).toBe(143);
		expect(ended.output).toContain("HOBO_CODE_MUX_INTERRUPTED");
		expect(audit(f.hoboHome)).toEqual([
			"pam.GatewayStarted",
			"pam.SessionStarted",
			"pam.SessionEnded(mux-interrupted)",
			"pam.GatewayStopped",
		]);
		expect(proxiesUnder(f.root)).toEqual([]);
		expect(f.sockets()).toEqual([]);
	}, 90_000);

	it("while tmux is set up, a pane's session with its proxy: stops the proxy, and ends by the signal", async () => {
		const f = await fixture();
		const ended = await muxSignalled(f, "tmux");
		expect(ended.signal, ended.output).toBeNull();
		expect(ended.code, ended.output).toBe(143);
		expect(audit(f.hoboHome)).toEqual([
			"pam.GatewayStarted",
			"pam.SessionStarted",
			"pam.GatewayStopped",
			"pam.SessionEnded(launcher-stop)",
		]);
		expect(proxiesUnder(f.root)).toEqual([]);
		expect(f.sockets()).toEqual([]);
	}, 90_000);

	it("while tmux is set up, kills the tmux session it created", async () => {
		const f = await fixture();
		const ended = await muxSignalled(f, "tmux");
		expect(ended.code, ended.output).toBe(143);
		expect(tmux(["has-session", "-t", `=${SESSION}`])).not.toBe(0);
	}, 90_000);

	it("while tmux is set up, kills only the windows it created: one another client added survives", async () => {
		const f = await fixture();
		const ended = await muxSignalled(
			f,
			"after new-session",
			`tmux new-window -d -t '=${SESSION}:' -n foreign 'sleep 600'`,
		);
		expect(ended.code, ended.output).toBe(143);
		expect(windowsOf(SESSION)).toEqual(["foreign"]);
		expect(proxiesUnder(f.root)).toEqual([]);
	}, 90_000);

	it("while tmux is set up, kills nothing by name: its session renamed, a new one of its name survives", async () => {
		const f = await fixture();
		const ended = await muxSignalled(
			f,
			"after new-session",
			`tmux rename-session -t '=${SESSION}' mine && tmux new-session -d -s ${SESSION} -n foreign 'sleep 600'`,
		);
		expect(ended.code, ended.output).toBe(143);
		expect(windowsOf(SESSION)).toEqual(["foreign"]);
		expect(tmux(["has-session", "-t", "=mine"])).not.toBe(0);
		expect(proxiesUnder(f.root)).toEqual([]);
	}, 90_000);

	it("while tmux is set up, in a session that was there before it, removes the windows it added and keeps the rest", async () => {
		const f = await fixture();
		expect(
			tmux(["new-session", "-d", "-s", SESSION, "-n", "theirs", "sleep 600"]),
		).toBe(0);
		const ended = await muxSignalled(f, "tmux");
		expect(ended.code, ended.output).toBe(143);
		expect(windowsOf(SESSION)).toEqual(["theirs"]);
		expect(proxiesUnder(f.root)).toEqual([]);
	}, 90_000);

	it("while tmux is set up, leaves a session that was there before it", async () => {
		const f = await fixture();
		expect(tmux(["new-session", "-d", "-s", SESSION, "sleep 600"])).toBe(0);
		const ended = await muxSignalled(f, "tmux");
		expect(ended.code, ended.output).toBe(143);
		expect(tmux(["has-session", "-t", `=${SESSION}`])).toBe(0);
		expect(proxiesUnder(f.root)).toEqual([]);
	}, 90_000);
});
