import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildCorrelation,
	createDebugReplayRecorder,
	createFilesystemDualFixtures,
} from "@hobo/replay";
import { loadStationEvents } from "@hobo/stations";
import { describe, expect, it } from "vitest";

import {
	AgentLifecycleState,
	SessionLifecycleState,
} from "../src/_generated/code_harness_pb.js";
import { runHoboCodeCli } from "../src/cli.js";
import { DEV_MACHINES_FILE } from "../src/dev-machines.js";
import {
	createLocalSessionControl,
	sessionCommandEnvelope,
} from "../src/local-session-control.js";
import type { MuxRunner } from "../src/mux.js";
import {
	authorizationLeaseDelay,
	forkResidentSession,
	remoteSessionServeSshArgs,
	runResidentSessionCli,
	shouldWaitForResidentSession,
} from "../src/resident-session-cli.js";
import { sessionProcessRunner } from "../src/session-orchestrator.js";

function git(cwd: string, args: readonly string[]): void {
	const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr);
}

function repository(): string {
	const root = mkdtempSync(join(tmpdir(), "hobo-session-cli-repo-"));
	git(root, ["init", "-q", "-b", "main"]);
	git(root, ["config", "user.email", "test@example.com"]);
	git(root, ["config", "user.name", "Test"]);
	writeFileSync(join(root, "README.md"), "base\n");
	git(root, ["add", "-A"]);
	git(root, ["commit", "-qm", "base"]);
	return root;
}

function fakeTmux(): MuxRunner {
	let pane = 0;
	const sessions = new Set<string>();
	return {
		async run(args) {
			if (args[0] === "has-session") {
				const target = args[args.indexOf("-t") + 1] ?? "";
				return { code: sessions.has(target) ? 0 : 1, stdout: "" };
			}
			if (args[0] === "new-session") {
				sessions.add(args[args.indexOf("-s") + 1] ?? "");
			}
			if (["new-session", "new-window", "split-window"].includes(args[0] ?? ""))
				return { code: 0, stdout: `%${++pane}\n` };
			return { code: 0, stdout: "" };
		},
	};
}

describe("resident session debug replay", () => {
	it("shows a persisted debug timeline without a mutation surface", async () => {
		const home = mkdtempSync(join(tmpdir(), "hobo-session-replay-cli-"));
		try {
			const fixtures = createFilesystemDualFixtures(
				join(home, "durable", "code", "replay"),
			);
			const recorder = createDebugReplayRecorder({
				sessionId: "code-source-replay",
				correlation: buildCorrelation({
					stationId: "station:local",
					controlPlaneEventId: "hobo-code:source",
				}),
				store: fixtures.blobs,
				index: fixtures.index,
			});
			recorder.record({ track: "test", metadata: { status: "passed" } });
			await recorder.stop();

			const result = await runResidentSessionCli({
				args: ["replay", "source"],
				hoboHome: home,
				projectDir: home,
				approved: false,
			});
			expect(result?.message).toContain("test");
			expect(result?.data).toMatchObject({
				replay: {
					readOnly: true,
					level: "observable",
					timeline: [{ track: "test", sequence: 0 }],
				},
			});
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("forks into a new branch and records a checkpoint in the new session", async () => {
		const home = mkdtempSync(join(tmpdir(), "hobo-session-fork-cli-"));
		const project = repository();
		const control = createLocalSessionControl({
			hoboHome: home,
			tmux: fakeTmux(),
		});
		try {
			const source = await control.execute(
				sessionCommandEnvelope("source", 0n, "test", "createSession", {
					name: "source",
					projectRoot: project,
					branch: "code/source",
					clientId: "test",
				}),
			);
			const forked = await forkResidentSession({
				control,
				runner: sessionProcessRunner(),
				sourceSessionId: "source",
				actorId: "test",
				name: "investigation",
			});
			expect(forked.sourceCheckpoint.sessionId).toBe("source");
			expect(forked.snapshot.session?.id).not.toBe(source.session?.id);
			expect(forked.snapshot.session?.branch).toMatch(/^code\/investigation-/u);
			expect(forked.snapshot.checkpoints).toEqual([
				expect.objectContaining({
					label: expect.stringContaining(forked.sourceCheckpoint.id),
				}),
			]);
		} finally {
			control.close();
			rmSync(home, { recursive: true, force: true });
			rmSync(project, { recursive: true, force: true });
		}
	});
});

describe("resident session remote browser", () => {
	it("does not wait on stale agent state after a session is terminal", () => {
		expect(
			shouldWaitForResidentSession(SessionLifecycleState.RUNNING, [
				AgentLifecycleState.WORKING,
			]),
		).toBe(true);
		expect(
			shouldWaitForResidentSession(SessionLifecycleState.STOPPED, [
				AgentLifecycleState.WORKING,
			]),
		).toBe(false);
	});
	it("fails closed at the Station authorization deadline", () => {
		expect(
			authorizationLeaseDelay(
				"2026-08-12T00:00:00.000Z",
				Date.parse("2026-08-11T23:59:59.000Z"),
			),
		).toBe(1_000);
		expect(() =>
			authorizationLeaseDelay(
				"2026-08-11T23:59:59.000Z",
				Date.parse("2026-08-12T00:00:00.000Z"),
			),
		).toThrow("expired or invalid");
	});
	it("constructs one fixed loopback SSH forward to the declared machine", () => {
		expect(
			remoteSessionServeSshArgs(
				{
					id: "build-box",
					host: "build-box.ts.net",
					user: "agent",
					isolationClass: "development",
				},
				4242,
				"/run/user/1000/hobo-agent.sock",
			),
		).toEqual([
			"-T",
			"-o",
			"IdentityAgent=/run/user/1000/hobo-agent.sock",
			"-o",
			"IdentityFile=none",
			"-o",
			"PreferredAuthentications=publickey",
			"-o",
			"PasswordAuthentication=no",
			"-o",
			"KbdInteractiveAuthentication=no",
			"-o",
			"BatchMode=yes",
			"-o",
			"ExitOnForwardFailure=yes",
			"-L",
			"127.0.0.1:4242:127.0.0.1:4242",
			"agent@build-box.ts.net",
			"hobo-code",
			"session",
			"serve",
			"--port",
			"4242",
		]);
	});

	it("refuses remote forwarding without a Station-authorized agent", () => {
		expect(() =>
			remoteSessionServeSshArgs(
				{
					id: "build-box",
					host: "build-box.ts.net",
					isolationClass: "development",
				},
				4242,
				"",
			),
		).toThrow("did not provide an SSH agent");
	});

	it("requires a fixed port before resolving a remote machine", async () => {
		const home = mkdtempSync(join(tmpdir(), "hobo-session-home-"));
		try {
			const result = await runHoboCodeCli(
				["session", "serve", "--host", "build-box"],
				{ hoboHome: home },
			);
			expect(result.ok).toBe(false);
			expect(result.code).toBe("HOBO_CODE_SESSION_REMOTE_PORT_REQUIRED");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("does not self-initialize a Station to authorize remote access", async () => {
		const home = mkdtempSync(join(tmpdir(), "hobo-session-home-"));
		const project = mkdtempSync(join(tmpdir(), "hobo-session-project-"));
		writeFileSync(
			join(project, DEV_MACHINES_FILE),
			JSON.stringify({
				machines: [
					{
						id: "build-box",
						host: "build-box.ts.net",
						isolationClass: "development",
					},
				],
			}),
		);
		try {
			const result = await runHoboCodeCli(
				["session", "serve", "--host", "build-box", "--port", "4242"],
				{ hoboHome: home, cwd: project },
			);
			expect(result.ok).toBe(false);
			expect(result.message).toMatch(/station .* not found/);
			expect(loadStationEvents(home, "station:local")).toEqual([]);
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(project, { recursive: true, force: true });
		}
	});

	it("authorizes and audits a declared machine before returning the forward", async () => {
		const home = mkdtempSync(join(tmpdir(), "hobo-session-home-"));
		const project = mkdtempSync(join(tmpdir(), "hobo-session-project-"));
		writeFileSync(
			join(project, DEV_MACHINES_FILE),
			JSON.stringify({
				machines: [
					{
						id: "build-box",
						host: "build-box.ts.net",
						user: "agent",
						isolationClass: "development",
					},
				],
			}),
		);
		const registered: unknown[] = [];
		const requests: unknown[] = [];
		let closed = false;
		try {
			const result = await runHoboCodeCli(
				["session", "serve", "--host", "build-box", "--port", "4242"],
				{
					hoboHome: home,
					cwd: project,
					openStationGateway: async () => ({
						broker: {
							registerTarget(target) {
								registered.push(target);
							},
							async brokerSession(request) {
								requests.push(request);
								return {
									sessionId: "pam-session-1",
									expiresAt: "2026-08-12T00:00:00.000Z",
									credentialRef: "tokenref://must-not-leak",
									protocol: "hobo-svid",
								};
							},
						},
						auditTypes: () => ["pam.SessionStarted"],
						yardDrainCount: () => 2,
						resolveSshIdentity: async (pane) => ({
							pane: {
								...pane,
								identityAgent: "/run/user/1000/hobo-agent.sock",
							},
							stop: async () => {},
						}),
						handoffSshIdentity: async (pane) => ({
							pane: {
								...pane,
								identityAgent: "/run/user/1000/hobo-agent.sock",
							},
							stop: async () => {},
						}),
						close: async () => {
							closed = true;
						},
					}),
				},
			);
			expect(result.ok).toBe(true);
			expect(registered).toEqual([
				{
					id: "ssh:build-box",
					kind: "ssh",
					isolationClass: "development",
					address: "agent@build-box.ts.net",
				},
			]);
			expect(requests).toEqual([
				expect.objectContaining({
					subject: "hobo-code",
					target: "ssh:build-box",
					preferSecretless: true,
				}),
			]);
			expect(result.data).toEqual(
				expect.objectContaining({
					terminalAction: expect.objectContaining({
						kind: "forward-sessions",
						machine: expect.objectContaining({ id: "build-box" }),
						port: 4242,
						authorizationSessionId: "pam-session-1",
						authorizationExpiresAt: "2026-08-12T00:00:00.000Z",
						auditTypes: ["pam.SessionStarted"],
						credentialMode: "station-authorized-agent",
						identityAgent: "/run/user/1000/hobo-agent.sock",
					}),
				}),
			);
			expect(JSON.stringify(result.data)).not.toContain("tokenref://");
			expect(closed).toBe(false);
			const closeAuthorization =
				// SAFETY: parsed or fixture value is the named domain type after this assertion.
				(
					result.data as {
						terminalAction: { closeAuthorization: () => Promise<void> };
					}
				).terminalAction.closeAuthorization;
			await closeAuthorization();
			expect(closed).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(project, { recursive: true, force: true });
		}
	});

	it("tells its caller just before it opens the Station authorization", async () => {
		// The hobo-code entry holds the ending signals from there: until it
		// listened, a signal ended the process with the authorization open.
		const home = mkdtempSync(join(tmpdir(), "hobo-session-home-"));
		const project = mkdtempSync(join(tmpdir(), "hobo-session-project-"));
		writeFileSync(
			join(project, DEV_MACHINES_FILE),
			JSON.stringify({
				machines: [
					{
						id: "build-box",
						host: "build-box.ts.net",
						isolationClass: "development",
					},
				],
			}),
		);
		const order: string[] = [];
		try {
			const result = await runHoboCodeCli(
				["session", "serve", "--host", "build-box", "--port", "4242"],
				{
					hoboHome: home,
					cwd: project,
					signals: {
						hold: () => {
							order.push("hold signals");
						},
						first: undefined,
					},
					openStationGateway: async () => {
						order.push("open the authorization");
						return {
							broker: {
								registerTarget() {},
								async brokerSession() {
									throw new Error("policy denied");
								},
							},
							auditTypes: () => ["pam.SessionDenied"],
							yardDrainCount: () => 0,
							resolveSshIdentity: async () => {
								throw new Error("not reached");
							},
							handoffSshIdentity: async () => {
								throw new Error("not reached");
							},
							close: async () => {},
						};
					},
				},
			);
			expect(result.ok).toBe(false);
			expect(order).toEqual(["hold signals", "open the authorization"]);
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(project, { recursive: true, force: true });
		}
	});

	it("refuses an undeclared machine before opening the Station gateway", async () => {
		const home = mkdtempSync(join(tmpdir(), "hobo-session-home-"));
		const project = mkdtempSync(join(tmpdir(), "hobo-session-project-"));
		writeFileSync(
			join(project, DEV_MACHINES_FILE),
			JSON.stringify({
				machines: [
					{
						id: "build-box",
						host: "build-box.ts.net",
						isolationClass: "development",
					},
				],
			}),
		);
		let opened = false;
		try {
			const result = await runHoboCodeCli(
				["session", "serve", "--host", "other-box", "--port", "4242"],
				{
					hoboHome: home,
					cwd: project,
					openStationGateway: async () => {
						opened = true;
						throw new Error("must not open");
					},
				},
			);
			expect(result.ok).toBe(false);
			expect(result.code).toBe("HOBO_CODE_SESSION_UNKNOWN_MACHINE");
			expect(result.message).toContain("no fallback");
			expect(opened).toBe(false);
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(project, { recursive: true, force: true });
		}
	});

	it("does not open a forward when the Station denies the declared machine", async () => {
		const home = mkdtempSync(join(tmpdir(), "hobo-session-home-"));
		const project = mkdtempSync(join(tmpdir(), "hobo-session-project-"));
		writeFileSync(
			join(project, DEV_MACHINES_FILE),
			JSON.stringify({
				machines: [
					{
						id: "build-box",
						host: "build-box.ts.net",
						isolationClass: "production",
					},
				],
			}),
		);
		let closed = false;
		try {
			const result = await runHoboCodeCli(
				["session", "serve", "--host", "build-box", "--port", "4242"],
				{
					hoboHome: home,
					cwd: project,
					openStationGateway: async () => ({
						broker: {
							registerTarget() {},
							async brokerSession() {
								throw new Error("policy denied production browser access");
							},
						},
						auditTypes: () => ["pam.SessionDenied"],
						close: async () => {
							closed = true;
						},
					}),
				},
			);
			expect(result.ok).toBe(false);
			expect(result.code).toBe("HOBO_CODE_SESSION_REMOTE_DENIED");
			expect(result.message).toContain(
				"policy denied production browser access",
			);
			expect(result.data).not.toEqual(
				expect.objectContaining({
					terminalAction: expect.objectContaining({ kind: "forward-sessions" }),
				}),
			);
			expect(closed).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(project, { recursive: true, force: true });
		}
	});
});
