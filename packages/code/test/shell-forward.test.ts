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
import { join } from "node:path";
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
import type { ShellHost } from "../src/interactive-shell.js";
import { slashItemForInput } from "../src/interactive-shell.js";
import { type JsonObject, parseJsonObject } from "../src/json.js";
import { openStationGateway } from "../src/machine-sessions.js";
import { createDefaultShellHost } from "../src/shell-host.js";

// The interactive shell's `/sessions serve --host <machine>` runs the same
// verb as `hobo-code session serve --host`, which opens a Station
// authorization and hands it, with the forward, to its caller. The shell is
// that caller: it must run the forward and close the authorization however
// the forward ends, its own exit included. It printed the hand-off and ran
// nothing, and the authorization stayed open with a live agent socket.

const STATION = "station:local";

const roots: string[] = [];
const servers: Server[] = [];
const hosts: ShellHost[] = [];
const standIns: number[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.dispose?.();
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
		await sleep(50);
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

/** The audit of a session closed, saying `reason` (the gateway's own stop: gateway-stop). */
function closedWith(reason = "gateway-stop"): readonly string[] {
	return [
		"pam.GatewayStarted",
		"pam.SessionStarted",
		`pam.SessionEnded(${reason})`,
		"pam.GatewayStopped",
	];
}

/**
 * A shell host over a real local Station, a declared machine `box`, and a
 * stand-in `ssh` on its PATH that runs until it is released or signalled.
 * With `holdOpening`, the gateway, once open, is handed to the verb only at
 * `letOpen()`: the verb is still opening the authorization until then.
 * `sshScript` replaces the stand-in's body; `leaseMs` ends the
 * authorization's lease that long after it is brokered.
 */
async function shell(
	options: {
		readonly ssh?: boolean;
		readonly holdOpening?: boolean;
		readonly sshScript?: string;
		readonly leaseMs?: number;
	} = {},
) {
	const root = mkdtempSync(join(tmpdir(), "s"));
	roots.push(root);
	const hoboHome = join(root, "h");
	const project = join(root, "p");
	const bin = join(root, "b");
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
	const pidFile = join(root, "ssh.pid");
	const release = join(root, "ssh.release");
	if (options.ssh !== false) {
		writeFileSync(
			join(bin, "ssh"),
			`#!/bin/sh\necho $$ > '${pidFile}'\n${options.sshScript ?? `while [ ! -e '${release}' ]; do sleep 0.1; done\nexit 0`}\n`,
		);
		chmodSync(join(bin, "ssh"), 0o755);
	}
	const agentSocket = join(root, "a.sock");
	const agent = createServer((socket) => socket.end());
	servers.push(agent);
	await new Promise<void>((resolve) => agent.listen(agentSocket, resolve));
	const closes: (string | undefined)[] = [];
	let opened = false;
	let letOpen = (): void => {};
	const opening =
		options.holdOpening === true
			? new Promise<void>((resolve) => {
					letOpen = resolve;
				})
			: Promise.resolve();
	const host = createDefaultShellHost({
		hoboHome,
		cwd: project,
		env: {
			// No stand-in: no ssh at all, so the forward cannot start one.
			PATH: options.ssh === false ? bin : `${bin}:/usr/bin:/bin`,
			HOBO_HOME: hoboHome,
		},
		openStationGateway: async (context) => {
			const gateway = await openStationGateway({
				...context,
				sshAuthSock: agentSocket,
			});
			opened = true;
			await opening;
			const leaseMs = options.leaseMs;
			return {
				...gateway,
				...(leaseMs !== undefined
					? {
							broker: {
								registerTarget: (target) =>
									gateway.broker.registerTarget(target),
								brokerSession: async (request) => ({
									...(await gateway.broker.brokerSession(request)),
									expiresAt: new Date(Date.now() + leaseMs).toISOString(),
								}),
							},
						}
					: undefined),
				close: async (reason) => {
					closes.push(reason);
					await gateway.close(reason);
				},
			};
		},
	});
	hosts.push(host);
	const sockets = (): readonly string[] => {
		const dir = join(stationRoot(hoboHome, STATION), "ssh-agent");
		return existsSync(dir) ? readdirSync(dir) : [];
	};
	const sshPid = (): number | undefined => {
		if (!existsSync(pidFile)) return undefined;
		const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
		if (!standIns.includes(pid)) standIns.push(pid);
		return pid;
	};
	return {
		host,
		hoboHome,
		closes,
		release,
		sockets,
		sshPid,
		opened: () => opened,
		letOpen: () => letOpen(),
	};
}

async function serveInShell(host: ShellHost): Promise<string> {
	const item = slashItemForInput(
		`/sessions serve --host box --port 4242 --station ${STATION}`,
	);
	expect(item?.argv).toEqual([
		"session",
		"serve",
		"--host",
		"box",
		"--port",
		"4242",
		"--station",
		STATION,
	]);
	return host.runVerb(item?.argv ?? []);
}

describe("the shell's /sessions serve --host", () => {
	it("forwards, and its exit closes the authorization and ends ssh", async () => {
		const s = await shell();
		const text = await serveInShell(s.host);
		expect(text).toMatch(/^browser: /mu);
		expect(await until(() => s.sshPid() !== undefined, 30_000)).toBe(true);
		const ssh = s.sshPid() ?? 0;
		expect(running(ssh)).toBe(true);
		await s.host.dispose?.();
		expect(s.closes).toEqual(["shell-quit"]);
		expect(audit(s.hoboHome)).toEqual(closedWith("shell-quit"));
		expect(await until(() => !running(ssh), 10_000)).toBe(true);
		expect(s.sockets()).toEqual([]);
	}, 60_000);

	it("closes the authorization when ssh ends by itself", async () => {
		const s = await shell();
		await serveInShell(s.host);
		expect(await until(() => s.sshPid() !== undefined, 30_000)).toBe(true);
		writeFileSync(s.release, "");
		expect(await until(() => s.closes.length > 0, 30_000)).toBe(true);
		expect(audit(s.hoboHome)).toEqual(closedWith());
		expect(s.sockets()).toEqual([]);
		await s.host.dispose?.();
		expect(s.closes).toEqual([undefined]);
	}, 60_000);

	it("quit while the verb opens the authorization: waits for the verb, which closes it saying shell-quit", async () => {
		const s = await shell({ holdOpening: true });
		const verb = serveInShell(s.host);
		expect(await until(s.opened, 30_000)).toBe(true);
		const quitting = s.host.dispose?.();
		await sleep(100);
		s.letOpen();
		await quitting;
		// Closed before the shell's dispose was done, never left to its lease.
		expect(s.closes).toEqual(["shell-quit"]);
		expect(audit(s.hoboHome)).toEqual(closedWith("shell-quit"));
		expect(s.sockets()).toEqual([]);
		expect(await verb).toMatch(/^not forwarded: the shell is closing/mu);
		expect(s.sshPid()).toBeUndefined();
	}, 60_000);

	it("closes the authorization when the forward cannot start ssh", async () => {
		const s = await shell({ ssh: false });
		await serveInShell(s.host);
		expect(await until(() => s.closes.length > 0, 30_000)).toBe(true);
		expect(audit(s.hoboHome)).toEqual(closedWith());
		expect(s.sockets()).toEqual([]);
	}, 60_000);
});

describe("the shell's forward, ending while the shell stays", () => {
	it("refused by ssh: tells the shell why, with ssh's last line scrubbed", async () => {
		const s = await shell({
			sshScript: [
				"printf 'debug1: Connecting to box.ts.net\\n' >&2",
				"printf 'Permission denied (publickey). password=hunter2 \\033[31mred\\033[0m\\n' >&2",
				"exit 255",
			].join("\n"),
		});
		const notices: string[] = [];
		s.host.onNotice?.((text) => notices.push(text));
		await serveInShell(s.host);
		expect(await until(() => notices.length > 0, 30_000)).toBe(true);
		const [notice = ""] = notices;
		expect(notice).toMatch(/^✕ forward · box$/mu);
		expect(notice).toContain("ssh exited with 255");
		expect(notice).toContain(
			"ssh: Permission denied (publickey). password=*** red",
		);
		expect(notice).not.toContain("hunter2");
		expect(notice).not.toContain(String.fromCharCode(0x1b));
		expect(notice).toContain("the Station authorization is closed");
		expect(audit(s.hoboHome)).toEqual(closedWith());
	}, 60_000);

	it("at the lease: tells the shell the authorization ran out", async () => {
		const s = await shell({ leaseMs: 2_000 });
		const notices: string[] = [];
		s.host.onNotice?.((text) => notices.push(text));
		await serveInShell(s.host);
		expect(await until(() => notices.length > 0, 30_000)).toBe(true);
		expect(notices[0]).toContain("the Station authorization's lease ran out");
		expect(audit(s.hoboHome)).toEqual(closedWith());
	}, 60_000);

	it("says nothing when the shell stops the forward itself", async () => {
		const s = await shell();
		const notices: string[] = [];
		s.host.onNotice?.((text) => notices.push(text));
		await serveInShell(s.host);
		expect(await until(() => s.sshPid() !== undefined, 30_000)).toBe(true);
		await s.host.dispose?.();
		expect(notices).toEqual([]);
	}, 60_000);
});

describe("the shell's forward, its process hung past the lease", () => {
	it("ends ssh at the lease through its watchdog, though the shell's own timer cannot run", async () => {
		// The fixture runs the forward, its lease 2 s away, then blocks its
		// event loop for 15 s; the watchdog ends ssh at the lease regardless.
		const root = mkdtempSync(join(tmpdir(), "s"));
		roots.push(root);
		const hoboHome = join(root, "h");
		const project = join(root, "p");
		const bin = join(root, "b");
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
		const pidFile = join(root, "ssh.pid");
		writeFileSync(
			join(bin, "ssh"),
			`#!/bin/sh\necho $$ > '${pidFile}'\nwhile :; do sleep 0.1; done\n`,
		);
		chmodSync(join(bin, "ssh"), 0o755);
		const agentSocket = join(root, "a.sock");
		const agent = createServer((socket) => socket.end());
		servers.push(agent);
		await new Promise<void>((resolve) => agent.listen(agentSocket, resolve));
		const shellProcess = spawn(
			process.execPath,
			[
				fileURLToPath(
					new URL("./fixtures/shell-forward-blocked.mjs", import.meta.url),
				),
			],
			{
				cwd: project,
				env: {
					PATH: `${bin}:/usr/bin:/bin`,
					HOBO_HOME: hoboHome,
					PROJECT: project,
					AGENT_SOCKET: agentSocket,
					SSH_PID: pidFile,
					LEASE_MS: "2000",
					BLOCK_MS: "15000",
					HOBO_CODE_SEAT_AGENTS: "0",
					TMUX_TMPDIR: process.env.TMUX_TMPDIR ?? "",
				},
				stdio: "ignore",
			},
		);
		const pid = shellProcess.pid ?? -1;
		standIns.push(pid);
		expect(await until(() => existsSync(pidFile), 30_000)).toBe(true);
		const ssh = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
		standIns.push(ssh);
		expect(await until(() => !running(ssh), 9_000)).toBe(true);
		// Ended by the watchdog, while the shell's process was still blocked.
		expect(running(pid)).toBe(true);
	}, 60_000);
});
