import { spawn } from "node:child_process";
import { first } from "@hobo/core/total-access";
import { describe, expect, it } from "vitest";
import { stripSgr as plain } from "../src/ansi.js";
import { harnessViewFromLivePanes } from "../src/harness-session-view.js";
import type { InSessionPanes } from "../src/in-session-panes.js";
import { refreshInSessionPanes } from "../src/in-session-panes.js";
import {
	createInitialShellState,
	enterPaneInteract,
	reduceShellKey,
	renderShellFrame,
	resolvePaneInteractTarget,
} from "../src/interactive-shell.js";
import type { MuxRunner } from "../src/mux.js";
import { isPaneInteractDetach } from "../src/pane-interact.js";
import { cellWidth } from "../src/rubberhose.js";
import { trackChild } from "./subprocess-cleanup.js";

async function tmuxOk(): Promise<boolean> {
	return await new Promise((resolve) => {
		const child = spawn("tmux", ["has-session", "-t", "hobo"]);
		trackChild(child);
		child.on("close", (code) => resolve(code === 0));
		child.on("error", () => resolve(false));
	});
}

function realTmuxRunner(): MuxRunner {
	return {
		async run(args) {
			return await new Promise((resolve, reject) => {
				const child = spawn("tmux", [...args]);
				trackChild(child);
				let stdout = "";
				let stderr = "";
				child.stdout?.setEncoding("utf8");
				child.stdout?.on("data", (c: string) => {
					stdout += c;
				});
				child.stderr?.setEncoding("utf8");
				child.stderr?.on("data", (c: string) => {
					stderr += c;
				});
				child.on("error", reject);
				child.on("close", (code) => resolve({ code, stdout, stderr }));
			});
		},
	};
}

describe("live multi-pane TV attach parity", () => {
	it("paints side-by-side splits inside the bezel; switch keeps ▐█▒", async () => {
		if (!(await tmuxOk())) return;
		const runner = realTmuxRunner();
		const listed = await runner.run([
			"list-panes",
			"-t",
			"hobo:pi",
			"-F",
			"#{pane_id}",
		]);
		if (listed.code !== 0) return;
		const ids = listed.stdout
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean);
		if (ids.length < 2) return;

		let live: InSessionPanes = {
			session: "hobo",
			windows: [
				{ name: "pi", target: first(ids, "ids"), kind: "coding-agent" },
			],
			focused: 0,
			focusedPane: 0,
			capture: "",
			note: "live",
			tmux: true,
		};
		live = await refreshInSessionPanes(live, runner);
		expect((live.windows[0]?.panes?.length ?? 0) >= 2).toBe(true);

		const view = harnessViewFromLivePanes(live);
		let state = createInitialShellState({
			welcome: false,
			reducedMotion: true,
			width: 100,
			height: 40,
		});
		state = enterPaneInteract({
			...state,
			focus: "agents",
			agentWork: true,
			livePanes: live,
			harnessView: view,
		});

		const before = renderShellFrame(state);
		const after = renderShellFrame(reduceShellKey(state, "]").state);

		for (const [label, frame] of [
			["before", before],
			["after", after],
		] as const) {
			const lines = frame.split("\n");
			for (const line of lines) {
				expect(cellWidth(line), label).toBe(100);
			}
			const glass = lines.filter((l) => plain(l).includes("▌"));
			expect(glass.length).toBeGreaterThan(5);
			for (const line of glass) {
				const p = plain(line);
				expect(p.includes("▐"), `${label}: ${p.slice(0, 80)}`).toBe(true);
			}
			expect(frame).toContain("│");
			expect(frame).not.toMatch(/┌─/);
			expect(frame).not.toMatch(/FULLSCREEN ATTACH|product chrome paused/i);
		}

		expect(resolvePaneInteractTarget(state)?.startsWith("%")).toBe(true);
		expect(isPaneInteractDetach("\x1c")).toBe(true);
		const cycled = reduceShellKey(state, "]");
		expect(cycled.state.paneInteract).toBe(true);
		expect(cycled.state.harnessView.focusedPane).not.toBe(
			state.harnessView.focusedPane,
		);
	});
});
