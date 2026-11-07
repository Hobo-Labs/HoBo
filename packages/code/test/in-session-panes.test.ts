import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectConfigSurface } from "../src/config-surface.js";
import {
	classifyWindowName,
	cycleInSessionWindow,
	ensureInSessionPanes,
	isProductPrompt,
	pickCodingWindow,
	pickSendWindow,
} from "../src/in-session-panes.js";
import type { MuxRunner } from "../src/mux.js";

function fakeRunner(script: {
	readonly versionOk?: boolean;
	readonly windows?: string;
	readonly applyOk?: boolean;
}): MuxRunner {
	return {
		run: async (args) => {
			if (args[0] === "-V") {
				return { code: script.versionOk === false ? 1 : 0, stdout: "tmux 3.4" };
			}
			if (args[0] === "has-session") {
				return { code: 0, stdout: "" };
			}
			if (args[0] === "list-windows") {
				return {
					code: 0,
					stdout: script.windows ?? "codex\t%1\nhobo-code\t%0\n",
				};
			}
			if (args[0] === "capture-pane") {
				return { code: 0, stdout: "codex › ready\n" };
			}
			if (args[0] === "new-session" || args[0] === "new-window") {
				return { code: script.applyOk === false ? 1 : 0, stdout: "%1\n" };
			}
			return { code: 0, stdout: "" };
		},
	};
}

describe("in-session panes", () => {
	it("prefers Codex over other coding CLIs", () => {
		const picked = pickCodingWindow([
			{ name: "hobo-code", target: "%0", kind: "harness" },
			{ name: "claude", target: "%2", kind: "coding-agent" },
			{ name: "codex", target: "%1", kind: "coding-agent" },
		]);
		expect(picked?.name).toBe("codex");
		expect(classifyWindowName("codex")).toBe("coding-agent");
	});

	it("keeps slash and btw on the product shell", () => {
		expect(isProductPrompt("/dev")).toBe(true);
		expect(isProductPrompt("btw what is this")).toBe(true);
		expect(isProductPrompt("add a login form")).toBe(false);
	});

	it("cycles windows without leaving the session", () => {
		const next = cycleInSessionWindow(
			{
				session: "hobo",
				windows: [
					{ name: "codex", target: "%1", kind: "coding-agent" },
					{ name: "claude", target: "%2", kind: "coding-agent" },
				],
				focused: 0,
				capture: "",
				note: "",
				tmux: true,
			},
			1,
		);
		expect(next.focused).toBe(1);
		expect(next.windows[next.focused]?.name).toBe("claude");
	});

	it("explains a missing tmux instead of asking the user to attach", async () => {
		const panes = await ensureInSessionPanes({
			runner: fakeRunner({ versionOk: false }),
			env: { PATH: "", HOME: "/tmp" },
		});
		expect(panes.windows).toEqual([]);
		expect(panes.note).toMatch(/tmux is not available/i);
	});

	it("returns empty panes when no agent CLI is on PATH", async () => {
		const panes = await ensureInSessionPanes({
			runner: fakeRunner({}),
			env: { PATH: "/empty", HOME: "/tmp" },
		});
		expect(panes.note).toMatch(/no agent CLI/i);
	});

	it("treats a focused harness as a steerable subagent", () => {
		const target = pickSendWindow({
			session: "hobo",
			windows: [
				{ name: "hobo-code", target: "%0", kind: "harness" },
				{ name: "codex", target: "%1", kind: "coding-agent" },
			],
			focused: 0,
			capture: "",
			note: "",
			tmux: true,
		});
		expect(target?.name).toBe("hobo-code");
	});

	it("seats nothing and starts no tmux when HOBO_CODE_SEAT_AGENTS=0, though an agent CLI is on PATH", async () => {
		// How a test keeps the developer's own agents out of the shell it starts.
		const bin = mkdtempSync(join(tmpdir(), "hobo-panes-"));
		writeFileSync(join(bin, "codex"), "");
		const ran: string[] = [];
		const runner: MuxRunner = {
			run: async (args) => {
				ran.push(args[0] ?? "");
				return { code: 0, stdout: args[0] === "-V" ? "tmux 3.4" : "%1\n" };
			},
		};
		const panes = await ensureInSessionPanes({
			runner,
			env: { PATH: bin, HOME: bin, HOBO_CODE_SEAT_AGENTS: "0" },
			cwd: bin,
			hoboHome: join(bin, ".hobo"),
		});
		expect(ran).toEqual([]);
		expect(panes.windows).toEqual([]);
		expect(panes.note).toMatch(/HOBO_CODE_SEAT_AGENTS=0/u);
	});

	it("reads HOBO_CODE_SEAT_AGENTS as its sibling switches do: 0, false, no or off is off", async () => {
		const bin = mkdtempSync(join(tmpdir(), "hobo-panes-"));
		writeFileSync(join(bin, "codex"), "");
		const seat = async (value: string | undefined): Promise<string[]> => {
			const ran: string[] = [];
			const runner: MuxRunner = {
				run: async (args) => {
					ran.push(args[0] ?? "");
					return { code: 1, stdout: "" };
				},
			};
			const env: NodeJS.ProcessEnv = { PATH: bin, HOME: bin };
			if (value !== undefined) env.HOBO_CODE_SEAT_AGENTS = value;
			await ensureInSessionPanes({
				runner,
				env,
				cwd: bin,
				hoboHome: join(bin, ".hobo"),
			});
			return ran;
		};
		for (const off of ["0", "false", "no", "off", "FALSE", " Off "]) {
			expect(await seat(off), off).toEqual([]);
		}
		for (const on of [undefined, "1", "true", "yes", "on"]) {
			expect(await seat(on), String(on)).toContain("-V");
		}
	});

	it("is listed in hobo-code config", () => {
		const knob = inspectConfigSurface(
			{ HOBO_CODE_SEAT_AGENTS: "off" },
			"/nonexistent-hobo-config-test",
		).knobs.find((entry) => entry.name === "HOBO_CODE_SEAT_AGENTS");
		expect(knob).toEqual(
			expect.objectContaining({ kind: "env", secret: false, present: true }),
		);
	});

	it("seats detected coding CLIs and skips the harness", async () => {
		const bin = mkdtempSync(join(tmpdir(), "hobo-panes-"));
		writeFileSync(join(bin, "codex"), "");
		writeFileSync(join(bin, "hobo-code"), "");
		const commands: string[] = [];
		const runner: MuxRunner = {
			run: async (args) => {
				if (args[0] === "-V") return { code: 0, stdout: "tmux 3.4" };
				if (args[0] === "has-session") return { code: 0, stdout: "" };
				if (args[0] === "list-windows") {
					return { code: 0, stdout: "codex\t%1\n" };
				}
				if (args[0] === "capture-pane") {
					return { code: 0, stdout: ">_ OpenAI Codex\n" };
				}
				if (args[0] === "new-session" || args[0] === "new-window") {
					commands.push(args.at(-1) ?? "");
					return { code: 0, stdout: "%1\n" };
				}
				return { code: 0, stdout: "" };
			},
		};
		const panes = await ensureInSessionPanes({
			runner,
			env: { PATH: bin, HOME: bin },
			cwd: bin,
			hoboHome: join(bin, ".hobo"),
		});
		expect(panes.tmux).toBe(true);
		expect(panes.windows.map((row) => row.name)).toContain("codex");
		expect(panes.windows.map((row) => row.name)).not.toContain("hobo-code");
		expect(panes.note).toMatch(/in-session · codex/i);
		expect(panes.note).toMatch(/Enter attach|\[ \] panes/i);
		// Existing window: no new-window, but respawn path may capture only.
		// Force a stale respawn case separately below.
	});

	it("respawns a dead Codex seat with isolated CODEX_HOME", async () => {
		const bin = mkdtempSync(join(tmpdir(), "hobo-panes-respawn-"));
		writeFileSync(join(bin, "codex"), "");
		const commands: string[] = [];
		let captures = 0;
		const runner: MuxRunner = {
			run: async (args) => {
				if (args[0] === "-V") return { code: 0, stdout: "tmux 3.4" };
				if (args[0] === "has-session") return { code: 0, stdout: "" };
				if (args[0] === "list-windows") {
					return { code: 0, stdout: "codex\t%1\n" };
				}
				if (args[0] === "capture-pane") {
					captures += 1;
					// First respawn probe is stale; later list capture is healthy.
					return {
						code: 0,
						stdout:
							captures === 1
								? "Error: failed to start embedded app server\n[codex exited 1 — press enter to close]"
								: ">_ OpenAI Codex\n",
					};
				}
				if (args[0] === "kill-window") return { code: 0, stdout: "" };
				if (args[0] === "new-window") {
					commands.push(args.at(-1) ?? "");
					return { code: 0, stdout: "%9\n" };
				}
				return { code: 0, stdout: "" };
			},
		};
		const panes = await ensureInSessionPanes({
			runner,
			env: { PATH: bin, HOME: bin },
			cwd: bin,
			hoboHome: join(bin, ".hobo"),
		});
		expect(commands.length).toBeGreaterThan(0);
		expect(commands.some((c) => c.includes("CODEX_HOME="))).toBe(true);
		expect(panes.windows.map((w) => w.name)).toContain("codex");
	});
});
