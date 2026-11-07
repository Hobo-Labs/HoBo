/**
 * Agent detection, devenv status, and the tmux session model.
 *
 * The multiplexer used to draw three hardcoded panes ("coord", "station",
 * "auth") that mapped to nothing real, and the hermetic-env surface only
 * detected markers in someone else's project. These pin the replacements:
 * panes come from agents actually installed, and local/remote targets are
 * the same shape.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { must } from "@hobo/core/total-access";
import { afterAll, describe, expect, it } from "vitest";
import { detectAgents, KNOWN_AGENTS } from "../src/agent-registry.js";
import { allocateAgentWorkspaces } from "../src/agent-workspaces.js";
import { inspectDevenv } from "../src/devenv.js";
import {
	applyMux,
	attachCommand,
	keepPaneOpen,
	type MuxRunner,
	type MuxTarget,
	placedCommand,
	planMux,
	safeWindowName,
	targetCommand,
} from "../src/mux.js";

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "mux-test-"));
	dirs.push(d);
	return d;
}

describe("agent auto-detection", () => {
	it("finds agents by binary or by leftover config, and says which", () => {
		const home = tmp();
		mkdirSync(join(home, ".codex"), { recursive: true });
		const found = detectAgents({
			which: (b) => (b === "claude" ? "/usr/bin/claude" : null),
			exists: (p) => p === join(home, ".codex"),
			home,
		});
		const ids = found.map((f) => f.id);
		expect(ids).toContain("claude");
		// Configured but not on PATH still deserves a pane.
		expect(ids).toContain("codex");
		expect(ids).not.toContain("gemini");
		const claude = must(
			found.find((f) => f.id === "claude"),
			"found.find((f) => f.id === 'claude')",
		);
		expect(claude.binary).toBe("/usr/bin/claude");
		expect(claude.evidence[0]).toMatch(/^bin:/);
		const codex = must(
			found.find((f) => f.id === "codex"),
			"found.find((f) => f.id === 'codex')",
		);
		expect(codex.binary).toBeNull();
		expect(codex.evidence[0]).toMatch(/^config:/);
	});

	it("detects nothing on a bare machine rather than inventing panes", () => {
		expect(
			detectAgents({
				which: () => null,
				exists: () => false,
				home: "/nowhere",
			}),
		).toEqual([]);
	});

	it("classifies local inference as an agent kind of its own", () => {
		const ollama = must(
			KNOWN_AGENTS.find((a) => a.id === "ollama"),
			"KNOWN_AGENTS.find((a) => a.id === 'ollama')",
		);
		expect(ollama.kind).toBe("inference");
	});

	it("detects Grok Build from the grok binary or ~/.grok", () => {
		const home = tmp();
		mkdirSync(join(home, ".grok"), { recursive: true });
		const found = detectAgents({
			which: (b) => (b === "grok" ? "/home/you/.local/bin/grok" : null),
			exists: (p) => p === join(home, ".grok"),
			home,
		});
		const grok = found.find((row) => row.id === "grok");
		expect(grok?.label).toBe("Grok Build");
		expect(grok?.kind).toBe("coding-agent");
		expect(grok?.command).toBe("grok");
		expect(grok?.evidence.some((row) => row.startsWith("bin:"))).toBe(true);
		expect(KNOWN_AGENTS.some((row) => row.id === "grok")).toBe(true);
	});
});

describe("uniform mux targets", () => {
	it("treats local, local-inference and ssh as the same shape", () => {
		const local: MuxTarget = {
			name: "claude",
			kind: "local",
			command: "claude",
		};
		const inference: MuxTarget = {
			name: "ollama",
			kind: "local-inference",
			command: "ollama serve",
		};
		const remote: MuxTarget = {
			name: "claude",
			kind: "ssh",
			command: "claude",
			host: "box.example",
			identityAgent: "/run/user/1000/hobo-agent.sock",
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		};
		// Every kind is a command in a pane, wrapped so the pane outlives it.
		expect(targetCommand(local)).toContain("claude");
		expect(targetCommand(inference)).toContain("ollama serve");
		expect(placedCommand(remote)).toBe("claude");
		expect(targetCommand(remote)).toContain("box.example");
		for (const t of [local, inference, remote]) {
			expect(targetCommand(t)).toMatch(/exited %s/);
		}
	});

	it("honours cwd for local targets", () => {
		expect(
			targetCommand({
				name: "x",
				kind: "local",
				command: "hobo-code",
				cwd: "/work/proj",
			}),
		).toContain("cd ");
	});

	it("sanitises window names tmux would misparse", () => {
		expect(safeWindowName("claude.code:1 pane")).toBe("claude-code-1-pane");
		expect(safeWindowName("...")).toBe("pane");
	});

	it("builds an attach command for local and remote alike", () => {
		expect(attachCommand("hobo")).toBe("tmux attach -t =hobo");
		expect(attachCommand("hobo", "box")).toBe(
			'ssh -t box "tmux attach -t =hobo"',
		);
	});
});

describe("panes outlive their command", () => {
	it("holds the pane open and shows the exit status", () => {
		// tmux destroys a window the instant its command returns, so an agent
		// that exits immediately used to vanish with no explanation — the
		// session simply had fewer panes than detected agents.
		const cmd = keepPaneOpen("ollama", "ollama serve");
		expect(cmd).toContain("ollama serve");
		expect(cmd).toContain("ollama exited");
		expect(cmd).toContain("read _");
	});

	it("does not let a quoted command break out of the wrapper", () => {
		const cmd = keepPaneOpen("x", "echo 'hi there'");
		expect(cmd.startsWith("sh -c '")).toBe(true);
		expect(cmd.endsWith("'")).toBe(true);
	});

	it("treats pane titles as labels, never shell source", () => {
		const cmd = keepPaneOpen("$(touch /tmp/owned)", "true");
		expect(cmd).not.toContain("$(touch");
		expect(cmd).toContain("touch-tmpowned exited");
	});
});

describe("applyMux", () => {
	/** A tmux stand-in: one session, `$0`; window `@n` is the nth made. */
	function fakeTmux(
		existing: string[] = [],
	): MuxRunner & { calls: string[][] } {
		const windows = [...existing];
		const calls: string[][] = [];
		return {
			calls,
			run: async (args) => {
				calls.push([...args]);
				if (args[0] === "has-session") {
					return { code: existing.length > 0 ? 0 : 1, stdout: "" };
				}
				if (args[0] === "display-message") return { code: 0, stdout: "$0\n" };
				if (args[0] === "list-windows") {
					return { code: 0, stdout: windows.join("\n") };
				}
				if (args[0] === "new-session" || args[0] === "new-window") {
					const name = must(
						args[args.indexOf("-n") + 1],
						"args[args.indexOf('-n') + 1]",
					);
					windows.push(name);
					const id = `@${windows.length - 1}`;
					return {
						code: 0,
						stdout: args[0] === "new-session" ? `$0 ${id}\n` : `${id}\n`,
					};
				}
				return { code: 0, stdout: "" };
			},
		};
	}

	it("creates a session with one window per agent", async () => {
		const plan = planMux("hobo", [
			{ name: "claude", kind: "local", command: "claude" },
			{ name: "codex", kind: "local", command: "codex" },
		]);
		const runner = fakeTmux();
		const result = await applyMux(plan, runner);
		expect(result.ok).toBe(true);
		expect(result.existed).toBe(false);
		expect(result.created).toEqual(["claude", "codex"]);
		expect(result.createdWindows).toEqual(["@0", "@1"]);
	});

	it("adds its windows to the session it made by its id, not its name", async () => {
		// Another client may rename the session, or make one of its name,
		// while mux adds its windows.
		const plan = planMux("hobo", [
			{ name: "claude", kind: "local", command: "claude" },
			{ name: "codex", kind: "local", command: "codex" },
		]);
		const runner = fakeTmux();
		await applyMux(plan, runner);
		const added = runner.calls.find((call) => call[0] === "new-window");
		expect(added?.[added.indexOf("-t") + 1]).toBe("$0:");
	});

	it("reuses an existing session and only adds missing windows", async () => {
		const plan = planMux("hobo", [
			{ name: "claude", kind: "local", command: "claude" },
			{ name: "codex", kind: "local", command: "codex" },
		]);
		const runner = fakeTmux(["claude"]);
		const result = await applyMux(plan, runner);
		expect(result.existed).toBe(true);
		// Idempotent: an existing pane is never duplicated or killed.
		expect(result.created).toEqual(["codex"]);
		expect(result.createdWindows).toEqual(["@1"]);
		expect(runner.calls.some((c) => c[0] === "kill-session")).toBe(false);
	});

	it("targets the session, not a window that happens to share its prefix", async () => {
		// tmux resolves `-t hobo` as a window target: with a window named
		// "hobo-code" it matched that instead of the session and failed with
		// "index 0 in use", so the session came up with a single pane.
		const plan = planMux("hobo", [
			{ name: "hobo-code", kind: "local", command: "hobo-code" },
			{ name: "claude", kind: "local", command: "claude" },
		]);
		const seen: string[] = [];
		const runner: MuxRunner = {
			run: async (args) => {
				if (args[0] === "has-session") return { code: 1, stdout: "" };
				if (args[0] === "new-window") {
					seen.push(
						must(args[args.indexOf("-t") + 1], "args[args.indexOf('-t') + 1]"),
					);
				}
				return { code: 0, stdout: "" };
			},
		};
		const result = await applyMux(plan, runner);
		expect(seen).toEqual(["=hobo:"]);
		expect(result.created).toEqual(["hobo-code", "claude"]);
	});

	it("does not trust stale window names when it just created the session", async () => {
		// A same-named session being torn down could still answer list-windows,
		// and those stale names made applyMux skip creating real windows — the
		// session came up with one pane instead of six.
		const plan = planMux("hobo", [
			{ name: "claude", kind: "local", command: "claude" },
			{ name: "codex", kind: "local", command: "codex" },
		]);
		const runner: MuxRunner = {
			run: async (args) => {
				if (args[0] === "has-session") return { code: 1, stdout: "" };
				if (args[0] === "list-windows") {
					return { code: 0, stdout: "claude\ncodex\nghost" };
				}
				return { code: 0, stdout: "" };
			},
		};
		const result = await applyMux(plan, runner);
		expect(result.created).toEqual(["claude", "codex"]);
	});

	it("refuses to open an empty session when nothing was detected", async () => {
		const result = await applyMux(planMux("hobo", []), fakeTmux());
		expect(result.ok).toBe(false);
		expect(result.detail).toMatch(/no agents detected/);
	});

	it("reports a pane that tmux could not create", async () => {
		const plan = planMux("hobo", [
			{ name: "claude", kind: "local", command: "claude" },
			{ name: "codex", kind: "local", command: "codex" },
		]);
		const base = fakeTmux();
		const runner: MuxRunner = {
			run: async (args) =>
				args[0] === "new-window"
					? { code: 1, stdout: "", stderr: "tmux refused" }
					: base.run(args),
		};
		const result = await applyMux(plan, runner);
		expect(result.ok).toBe(false);
		expect(result.detail).toContain("codex");
		expect(result.detail).toContain("rollback complete");
		// By its window's id: the session goes with its last window, and no
		// session is ever killed by name.
		expect(base.calls).toContainEqual(["kill-window", "-t", "@0"]);
		expect(base.calls.some((call) => call[0] === "kill-session")).toBe(false);
		expect(result.created).toEqual([]);
	});

	it("removes only newly added windows when an existing session update fails", async () => {
		const plan = planMux("hobo", [
			{ name: "claude", kind: "local", command: "claude" },
			{ name: "codex", kind: "local", command: "codex" },
			{ name: "cursor", kind: "local", command: "cursor-agent" },
		]);
		const base = fakeTmux(["claude"]);
		const runner: MuxRunner = {
			run: async (args) =>
				args[0] === "new-window" && args.includes("cursor")
					? { code: 1, stdout: "", stderr: "tmux refused" }
					: base.run(args),
		};
		const result = await applyMux(plan, runner);
		expect(result.ok).toBe(false);
		expect(base.calls).toContainEqual(["kill-window", "-t", "@1"]);
		expect(base.calls.some((call) => call[0] === "kill-session")).toBe(false);
		expect(base.calls.some((call) => call.includes("@0"))).toBe(false);
	});

	it("reports panes that survive an incomplete rollback", async () => {
		const plan = planMux("hobo", [
			{ name: "claude", kind: "local", command: "claude" },
			{ name: "codex", kind: "local", command: "codex" },
		]);
		const runner: MuxRunner = {
			run: async (args) => {
				if (args[0] === "has-session") return { code: 1, stdout: "" };
				if (args[0] === "new-session") return { code: 0, stdout: "$0 @0\n" };
				if (args[0] === "new-window") return { code: 1, stdout: "" };
				if (args[0] === "kill-window") return { code: 1, stdout: "" };
				return { code: 0, stdout: "" };
			},
		};
		const result = await applyMux(plan, runner);
		expect(result.ok).toBe(false);
		expect(result.detail).toContain("rollback incomplete");
		expect(result.created).toEqual(["claude"]);
	});
});

describe("devenv status", () => {
	it("reports the declared config and how to enter it", () => {
		const root = tmp();
		writeFileSync(join(root, "devenv.nix"), "{}");
		writeFileSync(join(root, "devenv.yaml"), "inputs: {}");
		const status = inspectDevenv(root, {
			which: (b) => (b === "nix" || b === "devenv" ? `/usr/bin/${b}` : null),
			exists: (p) => p.endsWith("devenv.nix") || p.endsWith("devenv.yaml"),
			env: {},
			platform: "linux",
		});
		expect(status.declared).toBe(true);
		expect(status.files).toEqual(["devenv.nix", "devenv.yaml"]);
		expect(status.devenvAvailable).toBe(true);
		expect(status.enterCommand).toBe("devenv shell");
	});

	it("says plainly when the toolchain is missing rather than implying a shell", () => {
		const status = inspectDevenv("/pkg", {
			which: () => null,
			exists: () => true,
			env: {},
			platform: "linux",
		});
		expect(status.nixAvailable).toBe(false);
		expect(status.notes.join(" ")).toMatch(/nix is not installed/);
	});

	it("flags platforms where nix does not run natively", () => {
		const status = inspectDevenv("/pkg", {
			which: () => null,
			exists: () => true,
			env: {},
			platform: "win32",
		});
		expect(status.platformSupported).toBe(false);
		expect(status.notes.join(" ")).toMatch(/WSL2/);
	});

	it("notices when already inside a devenv shell", () => {
		const status = inspectDevenv("/pkg", {
			which: () => "/usr/bin/devenv",
			exists: () => true,
			env: { DEVENV_ROOT: "/pkg" },
			platform: "linux",
		});
		expect(status.active).toBe(true);
	});
});

// Superseded by "ssh panes carry nothing local" below: an earlier round routed
// the exec wrapper and cwd over ssh, which sent this machine's absolute paths
// to a different machine. Remote isolation has to come from the remote's own
// workspace, not from local paths shipped across.
describe("shell quoting", () => {
	it("does not let a path expand a command substitution", () => {
		// Double quotes (what JSON.stringify emits) do not suppress `$(…)`.
		const command = placedCommand({
			name: "x",
			kind: "local",
			command: "claude",
			cwd: "/ws/$(touch pwned)",
		});
		expect(command).toBe("cd '/ws/$(touch pwned)' && claude");
		expect(command).not.toContain('"/ws/$(touch pwned)"');
	});
});

describe("remote panes do not pretend to be isolated", () => {
	it("skips local virtual worktrees for --host and says why", async () => {
		// Local workspace paths do not exist on the remote machine. Allocating
		// them either sends this machine's absolute paths somewhere they mean
		// nothing, or wastes the work outright.
		const result = await allocateAgentWorkspaces({
			workspaceRoot: "/local/ws",
			agentIds: ["claude", "codex"],
			fallbackRoot: "/local/fallback",
			shared: true,
			sharedReason: "--host box: panes run on the remote",
			runner: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
			env: { PATH: "" },
			bundled: () => null,
		});
		expect(result.backend).toBe("shared");
		expect(result.reason).toMatch(/--host box/);
		for (const w of result.workspaces) {
			expect(w.path).toBe("/local/ws");
			expect(w.exec).toBeUndefined();
		}
	});
});

describe("ssh panes carry nothing local", () => {
	it("drops a local cwd even when one is handed to it", () => {
		// `cd '/home/alice/proj' && claude` on a machine without that path is
		// `sh: 1: cd: can't cd to /home/alice/proj` — the agent never starts.
		// The target below *carries* a cwd, so this fails against a version that
		// relies on the caller having stripped it.
		const remote = placedCommand({
			name: "claude",
			kind: "ssh",
			host: "build-box",
			command: "claude",
			cwd: "/home/alice/proj",
			identityAgent: "/run/user/1000/hobo-agent.sock",
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		});
		expect(remote).toBe("claude");
		expect(remote).not.toContain("cd ");
	});

	it("drops a local exec wrapper too", () => {
		const remote = placedCommand({
			name: "claude",
			kind: "ssh",
			host: "build-box",
			command: "claude",
			cwd: "/ws/merged",
			exec: { binary: "/usr/local/bin/hobo-rift", root: "/ws", name: "claude" },
			identityAgent: "/run/user/1000/hobo-agent.sock",
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		});
		expect(remote).toBe("claude");
		expect(remote).not.toContain("hobo-rift");
	});

	it("the whole pane command carries no local path", () => {
		const pane = targetCommand({
			name: "claude",
			kind: "ssh",
			host: "build-box",
			command: "claude",
			cwd: "/home/alice/proj",
			exec: { binary: "/usr/local/bin/hobo-rift", root: "/ws", name: "claude" },
			identityAgent: "/run/user/1000/hobo-agent.sock",
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		});
		expect(pane).toContain("build-box");
		expect(pane).not.toContain("/home/alice/proj");
		expect(pane).not.toContain("hobo-rift");
	});
});
