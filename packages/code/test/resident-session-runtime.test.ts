import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "@bufbuild/protobuf";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import {
	AgentLifecycleState,
	AgentRunSchema,
	PaneLifecycleState,
	SessionLifecycleState,
} from "../src/_generated/code_harness_pb.js";
import { type MuxRunner, tmuxRunner } from "../src/mux.js";
import { createResidentSessionRuntime } from "../src/resident-session-runtime.js";
import { sessionSnapshotJson } from "../src/session-contract.js";
import { killProcessGroup, trackChild } from "./subprocess-cleanup.js";

const roots: string[] = [];
const tmuxServers: string[] = [];
const lockChildren: ChildProcess[] = [];
const lockWorker = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures/session-lock-worker.mts",
);

function runLockWorker(
	dataDir: string,
	marker: string,
	tracer?: { readonly role: "first" | "second"; readonly deadOwner: string },
): Promise<number | null> {
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				lockWorker,
				dataDir,
				marker,
				...(tracer ? [tracer.role, tracer.deadOwner] : []),
			],
			{ stdio: "ignore" },
		);
		trackChild(child);
		lockChildren.push(child);
		child.once("exit", resolve);
	});
}

afterEach(() => {
	for (const child of lockChildren.splice(0)) {
		if (child.pid !== undefined) killProcessGroup(child.pid);
	}
	for (const server of tmuxServers.splice(0)) {
		spawnSync("tmux", ["-L", server, "kill-server"]);
	}
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "hobo-code-resident-"));
	roots.push(root);
	return root;
}

function sessionLockPath(dataDir: string, sessionId: string): string {
	return join(
		dataDir,
		"session-locks",
		`${createHash("sha256").update(sessionId).digest("hex")}.lock`,
	);
}

function fakeTmux(): MuxRunner & { calls: string[][] } {
	const calls: string[][] = [];
	let pane = 0;
	let lastInputCommand = "";
	const sessions = new Set<string>();
	return {
		calls,
		async run(args) {
			calls.push([...args]);
			if (args[0] === "has-session") {
				const target = args[args.indexOf("-t") + 1] ?? "";
				return {
					code: sessions.has(target) ? 0 : 1,
					stdout: "",
					stderr: "can't find session",
				};
			}
			if (args[0] === "kill-session") {
				sessions.delete(args[args.indexOf("-t") + 1] ?? "");
			}
			if (args[0] === "show-options") {
				return {
					code: lastInputCommand ? 0 : 1,
					stdout: lastInputCommand,
				};
			}
			if (args[0] === "send-keys" && args.includes("set-option")) {
				lastInputCommand = args.at(-1) ?? "";
			}
			if (
				["new-session", "new-window", "split-window"].includes(args[0] ?? "")
			) {
				if (args[0] === "new-session") {
					sessions.add(args[args.indexOf("-s") + 1] ?? "");
				}
				pane += 1;
				return { code: 0, stdout: `%${pane}\n` };
			}
			return { code: 0, stdout: "" };
		},
	};
}

function geometryTmux(): MuxRunner {
	let pane = 0;
	let exists = false;
	const commands = new Map<string, string>();
	return {
		async run(args) {
			if (args[0] === "has-session") {
				return {
					code: exists ? 0 : 1,
					stdout: "",
					stderr: "can't find session",
				};
			}
			if (["new-session", "split-window"].includes(args[0] ?? "")) {
				exists = true;
				pane += 1;
				commands.set(`%${pane}`, args.at(-1) ?? "");
				return { code: 0, stdout: `%${pane}\n` };
			}
			if (args[0] === "list-panes") {
				const count = commands.size;
				return {
					code: 0,
					stdout: [...commands]
						.map(([id, command], index) => {
							const nested = count > 2 && index > 0;
							const lower = nested && index === 2;
							return [
								id,
								index === count - 1 ? "1" : "0",
								"1",
								index === 0 ? "0" : "60",
								lower ? "12" : "0",
								"60",
								nested ? (lower ? "28" : "12") : "40",
								"120",
								"40",
								command,
								"",
								"",
							].join("\t");
						})
						.join("\n"),
				};
			}
			return { code: 0, stdout: "" };
		},
	};
}

function realTmux(server: string): MuxRunner {
	tmuxServers.push(server);
	return tmuxRunner(["-L", server]);
}

describe("resident session runtime", () => {
	it("projects tmux cell geometry into the durable pane snapshot", async () => {
		const runtime = createResidentSessionRuntime({
			dataDir: tempRoot(),
			tmux: geometryTmux(),
		});
		const created = await runtime.create({
			id: "task-layout",
			name: "layout",
			projectRoot: "/repo",
			worktreePath: "/worktree",
			branch: "code/layout",
			clientId: "browser",
		});
		const horizontal = await runtime.splitPane(
			"task-layout",
			created.revision,
			created.focusedPaneId,
			"horizontal",
			"agent",
		);
		await runtime.splitPane(
			"task-layout",
			horizontal.revision,
			horizontal.focusedPaneId,
			"vertical",
			"logs",
		);
		const loaded = await runtime.load("task-layout");
		expect(loaded?.panes).toMatchObject([
			{
				leftColumn: 0,
				topRow: 0,
				width: 60,
				height: 40,
				windowWidth: 120,
				windowHeight: 40,
			},
			{
				leftColumn: 60,
				topRow: 0,
				width: 60,
				height: 12,
				windowWidth: 120,
				windowHeight: 40,
			},
			{
				leftColumn: 60,
				topRow: 12,
				width: 60,
				height: 28,
				windowWidth: 120,
				windowHeight: 40,
			},
		]);
		runtime.close();
	});

	it("keeps one tmux session durable across runtime restarts", async () => {
		const dataDir = tempRoot();
		const tmux = fakeTmux();
		const first = createResidentSessionRuntime({
			dataDir,
			tmux,
			now: () => "2026-08-10T20:00:00.000Z",
		});
		const created = await first.create({
			id: "task-1",
			name: "review",
			projectRoot: "/repo",
			worktreePath: "/repo/.worktrees/review",
			branch: "code/review",
			clientId: "cli-1",
		});
		expect(created.session?.lifecycleState).toBe(2);
		expect(created.tabs).toHaveLength(1);
		expect(created.panes[0]?.runtimeId).toBe("%1");
		first.close();

		const reopened = createResidentSessionRuntime({ dataDir, tmux });
		const restored = await reopened.load("task-1");
		expect(restored?.session?.branch).toBe("code/review");
		expect(restored?.panes[0]?.runtimeId).toBe("%1");
		expect(await reopened.list()).toHaveLength(1);
		reopened.close();
	});

	it("creates, focuses, controls, and closes real tmux-backed panes", async () => {
		const tmux = fakeTmux();
		const runtime = createResidentSessionRuntime({ dataDir: tempRoot(), tmux });
		const initial = await runtime.create({
			id: "task-2",
			name: "build",
			projectRoot: "/repo",
			worktreePath: "/worktree",
			branch: "code/build",
			clientId: "cli-1",
		});
		const tab = await runtime.createTab(
			"task-2",
			initial.revision,
			"tests",
			undefined,
			"hobo-code.git-workbench",
		);
		const newWindow = tmux.calls.find((call) => call[0] === "new-window");
		const encoded = /HOBO_PANE_META=([A-Za-z0-9_-]+)/u.exec(
			newWindow?.at(-1) ?? "",
		)?.[1];
		expect(
			JSON.parse(Buffer.from(encoded ?? "", "base64url").toString("utf8")),
		).toMatchObject({ role: "hobo-code.git-workbench" });
		const split = await runtime.splitPane(
			"task-2",
			tab.revision,
			tab.focusedPaneId,
			"vertical",
			"agent",
			["codex"],
		);
		const focused = await runtime.focusPane(
			"task-2",
			split.revision,
			split.focusedPaneId,
		);
		await runtime.sendInput(
			"task-2",
			focused.revision,
			focused.focusedPaneId,
			"review",
		);
		const detached = await runtime.detach("task-2", focused.revision, "cli-1");
		expect(detached.attachedClientIds).toEqual([]);
		const attached = await runtime.reattach(
			"task-2",
			detached.revision,
			"web-1",
		);
		expect(attached.attachedClientIds).toEqual(["web-1"]);
		const closed = await runtime.closePane(
			"task-2",
			attached.revision,
			attached.focusedPaneId,
		);
		await runtime.stop("task-2", closed.revision);

		expect(tmux.calls.map((call) => call[0])).toEqual(
			expect.arrayContaining([
				"new-session",
				"new-window",
				"split-window",
				"select-pane",
				"send-keys",
				"kill-pane",
				"kill-session",
			]),
		);
		runtime.close();
	});

	it("keeps pane closure parseable across reload after an agent run", async () => {
		const dataDir = tempRoot();
		const runtime = createResidentSessionRuntime({ dataDir, tmux: fakeTmux() });
		const created = await runtime.create({
			id: "task-close-agent-pane",
			name: "close-agent-pane",
			projectRoot: "/repo",
			worktreePath: "/worktree",
			branch: "code/close-agent-pane",
			clientId: "cli",
		});
		const split = await runtime.splitPane(
			"task-close-agent-pane",
			created.revision,
			created.focusedPaneId,
			"vertical",
			"agent",
		);
		const paneId = split.focusedPaneId;
		const started = await runtime.startAgent(
			"task-close-agent-pane",
			split.revision,
			paneId,
			"codex",
			["codex"],
			"review",
		);
		await expect(
			runtime.closePane("task-close-agent-pane", started.revision, paneId),
		).rejects.toThrow(`pane ${paneId} has an active agent`);

		const finished = await runtime.update(
			"task-close-agent-pane",
			started.revision,
			(snapshot) => {
				const run = snapshot.agentRuns[0];
				const pane = snapshot.panes.find(
					(candidate) => candidate.id === paneId,
				);
				if (!run || !pane) throw new Error("agent pane state is missing");
				run.lifecycleState = AgentLifecycleState.DONE;
				pane.agentRunId = undefined;
			},
		);
		const closed = await runtime.closePane(
			"task-close-agent-pane",
			finished.revision,
			paneId,
		);
		expect(closed.agentRuns).toEqual([]);
		runtime.close();

		const reopened = createResidentSessionRuntime({
			dataDir,
			tmux: fakeTmux(),
		});
		const restored = await reopened.load("task-close-agent-pane");
		expect(restored?.agentRuns).toEqual([]);
		expect(restored?.panes.some((pane) => pane.id === paneId)).toBe(false);
		reopened.close();
	});

	it("terminalizes active agents when their session stops", async () => {
		const runtime = createResidentSessionRuntime({
			dataDir: tempRoot(),
			tmux: fakeTmux(),
		});
		const created = await runtime.create({
			id: "task-stop-agent",
			name: "stop-agent",
			projectRoot: "/repo",
			worktreePath: "/worktree",
			branch: "code/stop-agent",
			clientId: "cli",
		});
		const started = await runtime.startAgent(
			"task-stop-agent",
			created.revision,
			created.focusedPaneId,
			"codex",
			["codex"],
			"",
		);
		const stopped = await runtime.stop("task-stop-agent", started.revision);
		expect(stopped.agentRuns[0]?.lifecycleState).toBe(
			AgentLifecycleState.STOPPED,
		);
		expect(stopped.agentRuns[0]?.summary).toBe("session stopped");
		expect(stopped.panes[0]?.agentRunId).toBeUndefined();
		runtime.close();
	});

	it("deduplicates acknowledged pane input without inventing a state revision", async () => {
		const tmux = fakeTmux();
		const runtime = createResidentSessionRuntime({ dataDir: tempRoot(), tmux });
		const created = await runtime.create({
			id: "task-input",
			name: "input",
			projectRoot: "/repo",
			worktreePath: "/worktree",
			branch: "code/input",
			clientId: "cli",
		});
		const first = await runtime.sendInput(
			"task-input",
			created.revision,
			created.focusedPaneId,
			"approve",
			"command-input-1",
		);
		const replayed = await runtime.sendInput(
			"task-input",
			created.revision,
			created.focusedPaneId,
			"approve",
			"command-input-1",
		);
		expect(first.revision).toBe(created.revision);
		expect(replayed.revision).toBe(created.revision);
		expect(tmux.calls.filter((call) => call[0] === "send-keys")).toHaveLength(
			1,
		);
		runtime.close();
	});

	it("starts a command-only agent without adding an empty argv entry", async () => {
		const runtime = createResidentSessionRuntime({
			dataDir: tempRoot(),
			tmux: fakeTmux(),
		});
		const created = await runtime.create({
			id: "task-command-only-agent",
			name: "command-only",
			projectRoot: "/repo",
			worktreePath: "/worktree",
			branch: "code/command-only",
			clientId: "cli",
		});
		const started = await runtime.startAgent(
			"task-command-only-agent",
			created.revision,
			created.focusedPaneId,
			"codex",
			["codex", "--full-auto"],
			"",
		);
		expect(started.agentRuns[0]?.lifecycleState).toBe(
			AgentLifecycleState.WORKING,
		);
		runtime.close();
	});

	it("does not replace an agent whose stop is unconfirmed", async () => {
		const runtime = createResidentSessionRuntime({
			dataDir: tempRoot(),
			tmux: fakeTmux(),
		});
		const created = await runtime.create({
			id: "task-unconfirmed-stop",
			name: "unconfirmed-stop",
			projectRoot: "/repo",
			worktreePath: "/worktree",
			branch: "code/unconfirmed-stop",
			clientId: "cli",
		});
		const started = await runtime.startAgent(
			"task-unconfirmed-stop",
			created.revision,
			created.focusedPaneId,
			"codex",
			["codex"],
			"review",
		);
		const stopped = await runtime.stopAgent(
			"task-unconfirmed-stop",
			started.revision,
			started.agentRuns[0]?.id ?? "missing",
		);
		expect(stopped.agentRuns[0]?.lifecycleState).toBe(
			AgentLifecycleState.UNKNOWN,
		);
		await expect(
			runtime.startAgent(
				"task-unconfirmed-stop",
				stopped.revision,
				stopped.focusedPaneId,
				"codex",
				["codex"],
				"replace",
			),
		).rejects.toThrow("already has an active agent");
		runtime.close();
	});

	it("does not stop a historical terminal run", async () => {
		const runtime = createResidentSessionRuntime({
			dataDir: tempRoot(),
			tmux: fakeTmux(),
		});
		const created = await runtime.create({
			id: "task-terminal-stop",
			name: "terminal-stop",
			projectRoot: "/repo",
			worktreePath: "/worktree",
			branch: "code/terminal-stop",
			clientId: "cli",
		});
		const started = await runtime.startAgent(
			created.session?.id ?? "missing",
			created.revision,
			created.focusedPaneId,
			"codex",
			["codex"],
			"review",
		);
		const runId = started.agentRuns[0]?.id ?? "missing";
		const finished = await runtime.update(
			created.session?.id ?? "missing",
			started.revision,
			(snapshot) => {
				const run = snapshot.agentRuns.find(
					(candidate) => candidate.id === runId,
				);
				const pane = snapshot.panes.find(
					(candidate) => candidate.id === run?.paneId,
				);
				if (!run || !pane) throw new Error("agent state is missing");
				run.lifecycleState = AgentLifecycleState.DONE;
				pane.agentRunId = undefined;
			},
		);
		await expect(
			runtime.stopAgent(
				created.session?.id ?? "missing",
				finished.revision,
				runId,
			),
		).rejects.toThrow("already terminal");
		runtime.close();
	});

	it("adopts a metadata-bearing tmux session left before its first event", async () => {
		const metadata = Buffer.from(
			JSON.stringify({
				paneId: "orphan-pane",
				tabId: "orphan-tab",
				paneTitle: "shell",
				tabTitle: "main",
				workingDirectory: "/worktree",
			}),
		).toString("base64url");
		const calls: string[][] = [];
		const runtime = createResidentSessionRuntime({
			dataDir: tempRoot(),
			tmux: {
				async run(args) {
					calls.push([...args]);
					if (args[0] === "has-session") return { code: 0, stdout: "" };
					if (args[0] === "list-panes") {
						return {
							code: 0,
							stdout: `%7\t1\t1\tenv HOBO_PANE_META=${metadata} sh -c true\n`,
						};
					}
					return { code: 0, stdout: "" };
				},
			},
		});
		const adopted = await runtime.create({
			id: "task-orphan",
			name: "orphan",
			projectRoot: "/repo",
			worktreePath: "/worktree",
			branch: "code/orphan",
			clientId: "cli",
		});
		expect(adopted.panes[0]?.id).toBe("orphan-pane");
		expect(adopted.panes[0]?.runtimeId).toBe("%7");
		expect(calls.some((call) => call[0] === "new-session")).toBe(false);
		runtime.close();
	});

	it("rejects stale writers before mutating tmux", async () => {
		const tmux = fakeTmux();
		const runtime = createResidentSessionRuntime({ dataDir: tempRoot(), tmux });
		await runtime.create({
			id: "task-3",
			name: "race",
			projectRoot: "/repo",
			worktreePath: "/worktree",
			branch: "code/race",
			clientId: "cli-1",
		});
		const before = tmux.calls.length;
		await expect(runtime.createTab("task-3", 0n, "stale")).rejects.toThrow(
			"expected revision",
		);
		expect(tmux.calls).toHaveLength(before);
		runtime.close();
	});

	it("serializes concurrent writers before either can orphan a pane", async () => {
		const dataDir = tempRoot();
		const tmux = fakeTmux();
		const first = createResidentSessionRuntime({ dataDir, tmux });
		const created = await first.create({
			id: "task-lock",
			name: "lock",
			projectRoot: "/repo",
			worktreePath: "/worktree",
			branch: "code/lock",
			clientId: "cli",
		});
		const second = createResidentSessionRuntime({ dataDir, tmux });
		const results = await Promise.allSettled([
			first.createTab("task-lock", created.revision, "one"),
			second.createTab("task-lock", created.revision, "two"),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			results.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		expect(tmux.calls.filter((call) => call[0] === "new-window")).toHaveLength(
			1,
		);
		first.close();
		second.close();
	});

	it("publishes the lock owner atomically across processes", async () => {
		const dataDir = tempRoot();
		const marker = join(dataDir, "mutations.log");
		const first = createResidentSessionRuntime({ dataDir, tmux: fakeTmux() });
		await first.create({
			id: "task-process-lock",
			name: "lock",
			projectRoot: "/repo",
			worktreePath: "/worktree",
			branch: "code/process-lock",
			clientId: "cli",
		});
		first.close();
		const statuses = await Promise.all([
			runLockWorker(dataDir, marker),
			runLockWorker(dataDir, marker),
		]);
		expect(statuses.sort()).toEqual([0, 2]);
		expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);
	});

	it("does not let stale-lock contenders remove the newly acquired owner", async () => {
		const dataDir = tempRoot();
		const marker = join(dataDir, "stale-race.log");
		const deadOwner = "2147483647";
		const first = createResidentSessionRuntime({ dataDir, tmux: fakeTmux() });
		await first.create({
			id: "task-process-lock",
			name: "lock",
			projectRoot: "/repo",
			worktreePath: "/worktree",
			branch: "code/process-lock",
			clientId: "cli",
		});
		first.close();
		writeFileSync(sessionLockPath(dataDir, "task-process-lock"), deadOwner);

		const statuses = await Promise.all([
			runLockWorker(dataDir, marker, { role: "first", deadOwner }),
			runLockWorker(dataDir, marker, { role: "second", deadOwner }),
		]);
		expect(statuses.sort()).toEqual([0, 2]);
		expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);
	});

	it("recovers when a stale-lock claimant crashes during takeover", async () => {
		const dataDir = tempRoot();
		const tmux = fakeTmux();
		const runtime = createResidentSessionRuntime({ dataDir, tmux });
		const created = await runtime.create({
			id: "task-reclaim-crash",
			name: "reclaim",
			projectRoot: "/repo",
			worktreePath: "/worktree",
			branch: "code/reclaim",
			clientId: "cli",
		});
		const path = sessionLockPath(dataDir, "task-reclaim-crash");
		const deadOwnerId = "2147483647-deadbeef";
		const marker = `hobo:${deadOwnerId}\n`;
		writeFileSync(path, marker);
		writeFileSync(
			`${path}.hobo-${deadOwnerId}.reclaim-2147483646-cafebabe`,
			marker,
		);

		const changed = await runtime.createTab(
			"task-reclaim-crash",
			created.revision,
			"recovered",
		);
		expect(changed.tabs.map((tab) => tab.title)).toContain("recovered");
		runtime.close();
	});

	it("fails closed when a lock owner is malformed", async () => {
		const dataDir = tempRoot();
		const tmux = fakeTmux();
		const runtime = createResidentSessionRuntime({ dataDir, tmux });
		const created = await runtime.create({
			id: "task-unknown-lock",
			name: "unknown",
			projectRoot: "/repo",
			worktreePath: "/worktree",
			branch: "code/unknown",
			clientId: "cli",
		});
		const path = sessionLockPath(dataDir, "task-unknown-lock");
		writeFileSync(path, "not-an-owner");
		const before = tmux.calls.length;

		await expect(
			runtime.createTab("task-unknown-lock", created.revision, "unsafe"),
		).rejects.toThrow("busy");
		expect(readFileSync(path, "utf8")).toBe("not-an-owner");
		expect(tmux.calls).toHaveLength(before);
		runtime.close();
	});

	it("replays an event written after the last SQLite snapshot", async () => {
		const dataDir = tempRoot();
		const tmux = fakeTmux();
		const runtime = createResidentSessionRuntime({ dataDir, tmux });
		const created = await runtime.create({
			id: "task-tail",
			name: "tail",
			projectRoot: "/repo",
			worktreePath: "/worktree",
			branch: "code/tail",
			clientId: "cli",
		});
		runtime.close();
		created.revision = 2n;
		if (created.session) created.session.updatedAt = "2026-08-10T21:00:00Z";
		const store = createRuntimeLocalEventStore({ dataDir });
		await store.append(
			"code-session:task-tail",
			[
				{
					type: "code.SessionChanged",
					data: { snapshot: sessionSnapshotJson(created) },
				},
			],
			{
				expectedSeq: 1,
				actor: { kind: "system", id: "test" },
				tenant: "local",
			},
		);
		store.close();

		const reopened = createResidentSessionRuntime({
			dataDir,
			tmux,
		});
		expect((await reopened.load("task-tail"))?.revision).toBe(2n);
		reopened.close();
	});

	it("marks a vanished tmux session missing and permits recreation", async () => {
		const dataDir = tempRoot();
		const first = createResidentSessionRuntime({ dataDir, tmux: fakeTmux() });
		const created = await first.create({
			id: "task-recover",
			name: "recover",
			projectRoot: "/repo",
			worktreePath: "/worktree",
			branch: "code/recover",
			clientId: "cli",
		});
		await first.update("task-recover", created.revision ?? 0n, (snapshot) => {
			const pane = snapshot.panes[0];
			if (!pane) throw new Error("expected initial pane");
			pane.agentRunId = "run-before-tmux-loss";
			snapshot.agentRuns.push(
				create(AgentRunSchema, {
					id: pane.agentRunId,
					sessionId: "task-recover",
					paneId: pane.id,
					provider: "codex",
					lifecycleState: AgentLifecycleState.WORKING,
					startedAt: "2026-08-10T00:00:00.000Z",
					updatedAt: "2026-08-10T00:00:00.000Z",
					summary: "agent running",
					terminalOnly: true,
				}),
			);
		});
		first.close();
		const restarted = createResidentSessionRuntime({
			dataDir,
			tmux: {
				run: async () => ({
					code: 1,
					stdout: "",
					stderr: "can't find session: h-task-recover",
				}),
			},
		});
		const missing = await restarted.load("task-recover");
		expect(missing?.session?.lifecycleState).toBe(SessionLifecycleState.FAILED);
		expect(missing?.panes[0]?.lifecycleState).toBe(PaneLifecycleState.MISSING);
		expect(missing?.panes[0]?.agentRunId).toBeUndefined();
		expect(missing?.agentRuns[0]?.lifecycleState).toBe(
			AgentLifecycleState.FAILED,
		);
		restarted.close();

		const recovered = createResidentSessionRuntime({
			dataDir,
			tmux: fakeTmux(),
		});
		const recreated = await recovered.create({
			id: "task-recover",
			name: "recover",
			projectRoot: "/repo",
			worktreePath: "/worktree",
			branch: "code/recover",
			clientId: "cli",
		});
		expect(recreated.session?.lifecycleState).toBe(
			SessionLifecycleState.RUNNING,
		);
		expect(recreated.revision).toBe(4n);
		recovered.close();
	});

	it("reconciles a tmux pane created before its event was appended", async () => {
		const dataDir = tempRoot();
		const first = createResidentSessionRuntime({ dataDir, tmux: fakeTmux() });
		await first.create({
			id: "task-drift",
			name: "drift",
			projectRoot: "/repo",
			worktreePath: "/worktree",
			branch: "code/drift",
			clientId: "cli",
		});
		first.close();
		const metadata = Buffer.from(
			JSON.stringify({
				paneId: "pane-after-crash",
				tabId: "tab-after-crash",
				paneTitle: "review",
				tabTitle: "review",
				workingDirectory: "/worktree",
			}),
		).toString("base64url");
		const tmux: MuxRunner = {
			run: async (args) =>
				args[0] === "has-session"
					? { code: 0, stdout: "" }
					: {
							code: 0,
							stdout: `%99\t1\t1\tenv HOBO_PANE_META=${metadata} sh -c true\n`,
						},
		};
		const restarted = createResidentSessionRuntime({ dataDir, tmux });
		const reconciled = await restarted.load("task-drift");
		expect(
			reconciled?.panes.some((pane) => pane.id === "pane-after-crash"),
		).toBe(true);
		expect(reconciled?.focusedPaneId).toBe("pane-after-crash");
		expect(reconciled?.revision).toBe(2n);
		restarted.close();
	});

	it("fails a markerless agent start intent so the pane can recover", async () => {
		const dataDir = tempRoot();
		const first = createResidentSessionRuntime({ dataDir, tmux: fakeTmux() });
		const created = await first.create({
			id: "task-agent-intent",
			name: "intent",
			projectRoot: "/repo",
			worktreePath: "/worktree",
			branch: "code/intent",
			clientId: "cli",
		});
		const runId = "run-before-crash";
		const intended = await first.update(
			"task-agent-intent",
			created.revision ?? 0n,
			(snapshot) => {
				snapshot.agentRuns.push(
					create(AgentRunSchema, {
						id: runId,
						sessionId: "task-agent-intent",
						paneId: snapshot.focusedPaneId,
						provider: "codex",
						lifecycleState: AgentLifecycleState.STARTING,
						startedAt: "2026-08-10T00:00:00.000Z",
						updatedAt: "2026-08-10T00:00:00.000Z",
						summary: "agent start requested",
						terminalOnly: true,
					}),
				);
				const pane = snapshot.panes.find(
					(candidate) => candidate.id === snapshot.focusedPaneId,
				);
				if (pane) pane.agentRunId = runId;
			},
		);
		first.close();
		const pane = intended.panes[0];
		const tab = intended.tabs[0];
		const metadata = Buffer.from(
			JSON.stringify({
				paneId: pane?.id,
				tabId: tab?.id,
				paneTitle: pane?.title,
				tabTitle: tab?.title,
				workingDirectory: pane?.workingDirectory,
			}),
		).toString("base64url");
		const restarted = createResidentSessionRuntime({
			dataDir,
			tmux: {
				run: async (args) =>
					args[0] === "has-session"
						? { code: 0, stdout: "" }
						: {
								code: 0,
								stdout: `${pane?.runtimeId}\t1\t1\tenv HOBO_PANE_META=${metadata} sh -c true\t\t\n`,
							},
			},
		});
		const recovered = await restarted.load("task-agent-intent");
		expect(recovered?.agentRuns[0]?.lifecycleState).toBe(
			AgentLifecycleState.FAILED,
		);
		expect(recovered?.panes[0]?.agentRunId).toBeUndefined();
		restarted.close();
	});

	it("ignores malformed tmux pane metadata instead of persisting it", async () => {
		const dataDir = tempRoot();
		const first = createResidentSessionRuntime({ dataDir, tmux: fakeTmux() });
		await first.create({
			id: "task-malformed",
			name: "malformed",
			projectRoot: "/repo",
			worktreePath: "/worktree",
			branch: "code/malformed",
			clientId: "cli",
		});
		first.close();
		const restarted = createResidentSessionRuntime({
			dataDir,
			tmux: {
				run: async (args) =>
					args[0] === "has-session"
						? { code: 0, stdout: "" }
						: {
								code: 0,
								stdout: "%1\t1\t1\tenv HOBO_PANE_META=e30 sh -c true\n",
							},
			},
		});
		const restored = await restarted.load("task-malformed");
		expect(restored?.revision).toBe(1n);
		expect(restored?.panes[0]?.id).not.toBe("");
		restarted.close();
	});

	it("does not persist failure when tmux availability is unknown", async () => {
		const dataDir = tempRoot();
		const tmux = fakeTmux();
		const first = createResidentSessionRuntime({ dataDir, tmux });
		await first.create({
			id: "task-probe",
			name: "probe",
			projectRoot: "/repo",
			worktreePath: "/worktree",
			branch: "code/probe",
			clientId: "cli",
		});
		first.close();
		const unavailable = createResidentSessionRuntime({
			dataDir,
			tmux: {
				run: async () => ({
					code: 1,
					stdout: "",
					stderr: "Operation not permitted",
				}),
			},
		});
		await expect(unavailable.load("task-probe")).rejects.toThrow(
			"availability unknown",
		);
		unavailable.close();

		const healthy = createResidentSessionRuntime({ dataDir, tmux });
		const restored = await healthy.load("task-probe");
		expect(restored?.session?.lifecycleState).toBe(
			SessionLifecycleState.RUNNING,
		);
		expect(restored?.revision).toBe(1n);
		healthy.close();
	});

	it("keeps long session IDs unique in tmux", async () => {
		const tmux = fakeTmux();
		const runtime = createResidentSessionRuntime({ dataDir: tempRoot(), tmux });
		for (const id of [
			"same-very-long-session-name-one",
			"same-very-long-session-name-two",
		]) {
			await runtime.create({
				id,
				name: id,
				projectRoot: "/repo",
				worktreePath: "/worktree",
				branch: `code/${id}`,
				clientId: "cli",
			});
		}
		const names = tmux.calls
			.filter((call) => call[0] === "new-session")
			.map((call) => call[call.indexOf("-s") + 1]);
		expect(new Set(names).size).toBe(2);
		runtime.close();
	});

	it("drives a real detachable tmux server", async ({ skip }) => {
		if (
			process.platform === "win32" ||
			spawnSync("tmux", ["-V"]).status !== 0
		) {
			skip();
			return;
		}
		const dataDir = tempRoot();
		const tmux = realTmux(`hobo-code-test-${process.pid}`);
		const probe = await tmux.run([
			"new-session",
			"-d",
			"-P",
			"-F",
			"#{pane_id}",
			"-s",
			"probe",
			"sleep 30",
		]);
		if (probe.code !== 0) {
			skip();
			return;
		}
		await tmux.run(["kill-session", "-t", "probe"]);
		const runtime = createResidentSessionRuntime({
			dataDir,
			tmux,
			shell: ["sh"],
		});
		const created = await runtime.create({
			id: "real",
			name: "real",
			projectRoot: dataDir,
			worktreePath: dataDir,
			branch: "code/real",
			clientId: "test",
		});
		const tabbed = await runtime.createTab("real", created.revision, "review", [
			"sh",
		]);
		const split = await runtime.splitPane(
			"real",
			tabbed.revision,
			tabbed.focusedPaneId,
			"horizontal",
			"agent",
			["sh"],
		);
		const panes = await tmux.run(["list-panes", "-a", "-F", "#{pane_id}"]);
		expect(panes.stdout.trim().split("\n")).toHaveLength(3);
		await runtime.sendInput(
			"real",
			split.revision,
			split.focusedPaneId,
			"dedupe-token",
			"real-input-1",
		);
		await runtime.sendInput(
			"real",
			split.revision,
			split.focusedPaneId,
			"dedupe-token",
			"real-input-1",
		);
		const captured = await tmux.run([
			"capture-pane",
			"-p",
			"-t",
			split.panes.find((pane) => pane.id === split.focusedPaneId)?.runtimeId ??
				"",
		]);
		expect(captured.stdout.match(/dedupe-token/gu)).toHaveLength(1);
		runtime.close();

		const reopened = createResidentSessionRuntime({ dataDir, tmux });
		const restored = await reopened.load("real");
		expect(restored?.revision).toBe(split.revision);
		await reopened.stop("real", split.revision);
		reopened.close();
	});
});
