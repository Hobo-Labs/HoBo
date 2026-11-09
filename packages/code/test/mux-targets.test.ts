import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { applyMux, type MuxTarget, planMux, tmuxRunner } from "../src/mux.js";

// mux named its tmux session `-t <name>`, and tmux takes a bare name as a
// prefix when no session has exactly that name. With only `t-old` there, mux
// "reattached to t" and placed its panes in `t-old`. It names sessions
// exactly now (`=t`, and `=t:` for a window target). Real tmux, on this test
// file's own server (test/isolate-tmux.ts), which is killed after the file;
// each case names sessions of its own, so none needs the server torn down
// (a server shutting down refuses the next case's session).

/** Start a session; a new server must not inherit a pipe it would hold. */
function newSession(name: string, window: string): number | null {
	return spawnSync(
		"tmux",
		["new-session", "-d", "-s", name, "-n", window, "sleep 600"],
		{ stdio: "ignore" },
	).status;
}

/** The windows of the session named exactly `session`, by name. */
function windows(session: string): readonly string[] {
	const listed = spawnSync(
		"tmux",
		["list-windows", "-t", `=${session}:`, "-F", "#{window_name}"],
		{ encoding: "utf8" },
	);
	return listed.status === 0
		? listed.stdout.split("\n").filter((line) => line.length > 0)
		: [];
}

const AGENTS: readonly MuxTarget[] = [
	{ name: "codex", kind: "local", command: "sleep 600" },
	{ name: "claude", kind: "local", command: "sleep 600" },
];

describe("mux's tmux session, named exactly", () => {
	it("creates its own session when only one whose name begins with its is there", async () => {
		expect(newSession("a-old", "theirs")).toBe(0);
		const applied = await applyMux(planMux("a", AGENTS), tmuxRunner());
		expect(applied.ok, applied.detail).toBe(true);
		expect(applied.existed).toBe(false);
		expect(windows("a")).toEqual(["codex", "claude"]);
		expect(windows("a-old")).toEqual(["theirs"]);
	});

	it("joins the session of exactly its name, adding only its own windows", async () => {
		expect(newSession("b", "theirs")).toBe(0);
		expect(newSession("b-old", "theirs")).toBe(0);
		const applied = await applyMux(planMux("b", AGENTS), tmuxRunner());
		expect(applied.ok, applied.detail).toBe(true);
		expect(applied.existed).toBe(true);
		expect(windows("b")).toEqual(["theirs", "codex", "claude"]);
		expect(windows("b-old")).toEqual(["theirs"]);
	});
});
