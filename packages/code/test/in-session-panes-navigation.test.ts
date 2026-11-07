/**
 * Reading, navigating, and steering the in-session tmux panes.
 *
 * `in-session-panes.test.ts` covers seating — which agents get placed, what
 * happens when tmux or the CLIs are missing. This file covers everything that
 * happens *after* a session exists: parsing tmux's output into windows and
 * leaves, moving focus between them, and sending keys.
 *
 * Two things make this worth pinning rather than eyeballing:
 *
 * - **Every parser here reads tab-separated tmux format strings.** tmux emits
 *   these with no schema and no error signal; a field that comes back empty or
 *   in a different order does not fail, it produces a plausible-looking window
 *   with the wrong target. Then keys go to the wrong agent.
 * - **The navigation helpers all wrap around.** Off-by-one at the wrap is the
 *   classic bug, and it presents as "the last pane is unreachable" — an
 *   irritation nobody files, so it survives.
 *
 * Where a helper sends keys, the assertion is on the exact argv. tmux takes
 * `-l` to mean "literal", and forgetting it turns a user's message into a
 * sequence of tmux commands — which is why the send path is checked verb by
 * verb rather than just for "it called send-keys".
 */
import { describe, expect, it } from "vitest";

import {
	captureInSessionPane,
	cycleInSessionLeaf,
	cycleInSessionWindow,
	emptyInSessionPanes,
	focusInSessionLeaf,
	type InSessionPanes,
	type InSessionWindow,
	isProductPrompt,
	listInSessionWindows,
	listWindowPaneLeaves,
	pickSendWindow,
	refreshInSessionPanes,
	sendKeysRawToInSessionPane,
	sendToInSessionPane,
} from "../src/in-session-panes.js";
import type { MuxRunner } from "../src/mux.js";

interface FakeTmux extends MuxRunner {
	readonly calls: readonly (readonly string[])[];
}

/** A tmux whose answer per verb the test states outright. */
function fakeTmux(
	answers: Record<string, { code?: number; stdout?: string }> = {},
): FakeTmux {
	const calls: string[][] = [];
	return {
		calls,
		async run(args) {
			calls.push([...args]);
			const answer = answers[args[0] ?? ""];
			return { code: answer?.code ?? 0, stdout: answer?.stdout ?? "" };
		},
	};
}

function leaf(
	id: string,
	index: number,
	active: boolean,
	capture = "",
): NonNullable<InSessionWindow["panes"]>[number] {
	return { id, index, active, width: 80, height: 24, capture };
}

function panes(overrides: Partial<InSessionPanes> = {}): InSessionPanes {
	return {
		session: "hobo",
		windows: [],
		focused: 0,
		focusedPane: 0,
		capture: "",
		note: "",
		tmux: true,
		...overrides,
	};
}

describe("listing windows", () => {
	it("parses a name and pane id out of the format string", async () => {
		const tmux = fakeTmux({
			"list-windows": { stdout: "codex\t%1\nclaude\t%2" },
		});
		const windows = await listInSessionWindows(tmux, "hobo");
		expect(windows.map((row) => [row.name, row.target])).toEqual([
			["codex", "%1"],
			["claude", "%2"],
		]);
	});

	it("returns nothing when tmux fails rather than parsing its error text", async () => {
		// tmux writes its diagnostics to stderr and exits non-zero. Parsing stdout
		// regardless would yield an empty-but-successful window list, which reads
		// downstream as "the session has no windows" rather than "tmux is broken".
		const tmux = fakeTmux({ "list-windows": { code: 1, stdout: "junk" } });
		expect(await listInSessionWindows(tmux, "hobo")).toEqual([]);
	});

	it("skips blank lines rather than inventing a nameless window", async () => {
		// tmux's output ends in a newline, so the naive split always yields one
		// empty trailing record. Unskipped it becomes a window with an empty name
		// and a `hobo:` target, which is a valid-looking target for nothing.
		const tmux = fakeTmux({ "list-windows": { stdout: "codex\t%1\n\n" } });
		expect(await listInSessionWindows(tmux, "hobo")).toHaveLength(1);
	});

	it("falls back to a session:name target when tmux gives no pane id", async () => {
		// An empty target would make every later `-t` argument address nothing,
		// and tmux's response to that is to act on the *current* pane instead —
		// so keys silently land wherever the user last was.
		const tmux = fakeTmux({ "list-windows": { stdout: "codex\t" } });
		const windows = await listInSessionWindows(tmux, "hobo");
		expect(windows[0]?.target).toBe("hobo:codex");
	});

	it("addresses the session it was asked about", async () => {
		const tmux = fakeTmux({ "list-windows": { stdout: "codex\t%1" } });
		await listInSessionWindows(tmux, "other");
		expect(tmux.calls[0]).toContain("=other:");
	});

	it("classifies a window name it does not recognise as unknown", async () => {
		// An unrecognised window is somebody's own shell. Guessing it was a coding
		// agent would make it a candidate for receiving prompts.
		const tmux = fakeTmux({ "list-windows": { stdout: "my-scratch\t%1" } });
		const windows = await listInSessionWindows(tmux, "hobo");
		expect(windows[0]?.kind).toBe("unknown");
	});
});

describe("listing pane leaves", () => {
	it("parses id, index, active, and size", async () => {
		const tmux = fakeTmux({
			"list-panes": { stdout: "%1\t0\t1\t80\t24" },
		});
		const leaves = await listWindowPaneLeaves(tmux, "hobo", "codex");
		expect(leaves[0]).toMatchObject({
			id: "%1",
			index: 0,
			active: true,
			width: 80,
			height: 24,
		});
	});

	it("treats anything but 1 as inactive", async () => {
		// tmux's `pane_active` is exactly "1" or "0". Truthiness on the string
		// would make "0" active, and then every pane in the window claims focus.
		const tmux = fakeTmux({ "list-panes": { stdout: "%1\t0\t0\t80\t24" } });
		const leaves = await listWindowPaneLeaves(tmux, "hobo", "codex");
		expect(leaves[0]?.active).toBe(false);
	});

	it("sorts leaves by index rather than by tmux's output order", async () => {
		// tmux lists panes in creation order, not layout order. Rendering them
		// unsorted puts the panes on screen in an order that does not match the
		// numbers the user sees in tmux itself.
		const tmux = fakeTmux({
			"list-panes": { stdout: "%9\t2\t0\t80\t24\n%1\t0\t1\t80\t24" },
		});
		const leaves = await listWindowPaneLeaves(tmux, "hobo", "codex");
		expect(leaves.map((row) => row.index)).toEqual([0, 2]);
	});

	it("returns nothing when the pane list is empty", async () => {
		const tmux = fakeTmux({ "list-panes": { stdout: "   \n" } });
		expect(await listWindowPaneLeaves(tmux, "hobo", "codex")).toEqual([]);
	});

	it("returns nothing when tmux fails", async () => {
		const tmux = fakeTmux({
			"list-panes": { code: 1, stdout: "%1\t0\t1\t8\t2" },
		});
		expect(await listWindowPaneLeaves(tmux, "hobo", "codex")).toEqual([]);
	});

	it("defaults an unparseable number to zero rather than NaN", async () => {
		// NaN propagates: it survives Math.min/max, compares false against
		// everything, and eventually reaches a tmux argument as the literal
		// string "NaN". Zero is wrong but bounded.
		const tmux = fakeTmux({ "list-panes": { stdout: "%1\tx\t1\ty\tz" } });
		const leaves = await listWindowPaneLeaves(tmux, "hobo", "codex");
		expect(leaves[0]).toMatchObject({ index: 0, width: 0, height: 0 });
	});

	it("captures each leaf's content alongside its geometry", async () => {
		const tmux = fakeTmux({
			"list-panes": { stdout: "%1\t0\t1\t80\t24" },
			"capture-pane": { stdout: "hello from the pane\n" },
		});
		const leaves = await listWindowPaneLeaves(tmux, "hobo", "codex");
		expect(leaves[0]?.capture).toBe("hello from the pane");
	});

	it("honours a caller's capture depth", async () => {
		// The depth is how much scrollback a reader gets. Ignoring it would make
		// a request for more history silently return the default window.
		const tmux = fakeTmux({ "list-panes": { stdout: "%1\t0\t1\t80\t24" } });
		await listWindowPaneLeaves(tmux, "hobo", "codex", { captureLines: 500 });
		expect(tmux.calls.find((call) => call[0] === "capture-pane")).toContain(
			"-500",
		);
	});
});

describe("capturing a pane", () => {
	it("strips the trailing blank lines tmux pads with", async () => {
		// A capture is rendered into a fixed-height box. Trailing blanks push the
		// real output off the top of it.
		const tmux = fakeTmux({ "capture-pane": { stdout: "line\n\n   \n" } });
		expect(await captureInSessionPane(tmux, "%1")).toBe("line");
	});

	it("keeps escape sequences so colour survives the round trip", async () => {
		// `-e` is what asks tmux for them. A capture stripped of colour renders as
		// a wall of grey text that looks nothing like the agent's own output.
		const tmux = fakeTmux({ "capture-pane": { stdout: "[31mred[0m" } });
		expect(await captureInSessionPane(tmux, "%1")).toContain("[31m");
		expect(tmux.calls[0]).toContain("-e");
	});

	it("asks for scrollback rather than just the visible screen", async () => {
		const tmux = fakeTmux();
		await captureInSessionPane(tmux, "%1", 120);
		expect(tmux.calls[0]).toEqual([
			"capture-pane",
			"-p",
			"-e",
			"-S",
			"-120",
			"-t",
			"%1",
		]);
	});
});

describe("sending to a pane", () => {
	it("sends the text literally, then Enter separately", async () => {
		// Without `-l`, tmux reads the text as key *names* — so a message
		// containing "C-c" would interrupt the agent instead of being typed to it.
		// Enter must be a second call for the same reason: it is a key name, and
		// sending it literally would type the word.
		const tmux = fakeTmux();
		await sendToInSessionPane(tmux, "%1", "hello world");
		expect(tmux.calls).toEqual([
			["send-keys", "-t", "%1", "-l", "--", "hello world"],
			["send-keys", "-t", "%1", "Enter"],
		]);
	});

	it("passes text starting with a dash after the -- guard", async () => {
		// `--` is what stops tmux reading the user's text as options. A prompt
		// beginning with "-t" would otherwise be parsed as a target argument.
		const tmux = fakeTmux();
		await sendToInSessionPane(tmux, "%1", "-t not-an-option");
		expect(tmux.calls[0]?.slice(3)).toEqual(["-l", "--", "-t not-an-option"]);
	});

	it("forwards raw keys without appending Enter", async () => {
		// Interactive menus read single keys. Appending Enter would submit the
		// menu on every keystroke.
		const tmux = fakeTmux();
		await sendKeysRawToInSessionPane(tmux, "%1", "j");
		expect(tmux.calls.some((call) => call.includes("Enter"))).toBe(false);
	});
});

describe("recognising a product prompt", () => {
	it("claims a slash command for the product shell", () => {
		expect(isProductPrompt("/mux pane")).toBe(true);
	});

	it("claims btw regardless of case", () => {
		expect(isProductPrompt("BTW what is this")).toBe(true);
	});

	it("tolerates leading whitespace", () => {
		// The composer does not trim before asking, so an indented "/help" that
		// fell through to the agent would look to the user like the key was lost.
		expect(isProductPrompt("   /help")).toBe(true);
	});

	it("does not claim ordinary prose for the product", () => {
		// Over-claiming is the worse direction: the user's actual message to the
		// agent gets swallowed by a shell that does not understand it.
		expect(isProductPrompt("please rename this function")).toBe(false);
	});

	it("does not claim a word that merely starts with btw", () => {
		// The word boundary is the whole point — "btwn" is prose.
		expect(isProductPrompt("btwn these two")).toBe(false);
	});

	it("does not claim a slash that appears mid-sentence", () => {
		expect(isProductPrompt("use src/index.ts")).toBe(false);
	});
});

describe("choosing where a prompt goes", () => {
	it("prefers the focused window when it can be steered", () => {
		// If focus did not win, a user watching one agent and typing would see
		// their message appear in a different one.
		const view = panes({
			windows: [
				{ name: "codex", target: "%1", kind: "coding-agent" },
				{ name: "claude", target: "%2", kind: "coding-agent" },
			],
			focused: 1,
		});
		expect(pickSendWindow(view)?.name).toBe("claude");
	});

	it("skips a focused window that is not an agent", () => {
		// The user's own shell is focusable but not steerable; sending a prompt
		// there would type it into their bash.
		const view = panes({
			windows: [
				{ name: "scratch", target: "%1", kind: "unknown" },
				{ name: "codex", target: "%2", kind: "coding-agent" },
			],
			focused: 0,
		});
		expect(pickSendWindow(view)?.name).toBe("codex");
	});

	it("falls back to a harness when no coding agent is seated", () => {
		const view = panes({
			windows: [{ name: "hobo", target: "%1", kind: "harness" }],
			focused: 0,
		});
		expect(pickSendWindow(view)?.name).toBe("hobo");
	});

	it("finds nothing to steer in an empty session", () => {
		// Returning undefined is what lets the caller say so. A default target
		// would send the prompt into whatever pane happened to be current.
		expect(pickSendWindow(panes())).toBeUndefined();
	});

	it("finds nothing to steer when only unknown windows exist", () => {
		const view = panes({
			windows: [{ name: "scratch", target: "%1", kind: "unknown" }],
		});
		expect(pickSendWindow(view)).toBeUndefined();
	});
});

describe("cycling windows", () => {
	function threeWindows(focused: number): InSessionPanes {
		return panes({
			windows: [
				{ name: "a", target: "%1", kind: "coding-agent" },
				{ name: "b", target: "%2", kind: "coding-agent" },
				{ name: "c", target: "%3", kind: "coding-agent" },
			],
			focused,
		});
	}

	it("advances forward", () => {
		expect(cycleInSessionWindow(threeWindows(0), 1).focused).toBe(1);
	});

	it("wraps past the end back to the first", () => {
		expect(cycleInSessionWindow(threeWindows(2), 1).focused).toBe(0);
	});

	it("wraps backwards from the first to the last", () => {
		// The modulo has to add the length before taking it, or this lands on -1
		// and the last window becomes unreachable going backwards.
		expect(cycleInSessionWindow(threeWindows(0), -1).focused).toBe(2);
	});

	it("resets the leaf when the window changes", () => {
		// A leaf index carried across windows points into a different split. Left
		// alone it addresses a pane that may not exist in the new window.
		const view = { ...threeWindows(0), focusedPane: 3 };
		expect(cycleInSessionWindow(view, 1).focusedPane).toBe(0);
	});

	it("clears the stale capture when the window changes", () => {
		// Otherwise the new window renders with the previous one's output until
		// the next refresh — which reads as the wrong agent having said it.
		const view = { ...threeWindows(0), capture: "old output" };
		expect(cycleInSessionWindow(view, 1).capture).toBe("");
	});

	it("does nothing in a session with no windows", () => {
		const empty = panes();
		expect(cycleInSessionWindow(empty, 1)).toBe(empty);
	});
});

describe("cycling leaves", () => {
	function split(focusedPane: number): InSessionPanes {
		return panes({
			windows: [
				{
					name: "codex",
					target: "%1",
					kind: "coding-agent",
					panes: [leaf("%1", 0, true, "first"), leaf("%2", 1, false, "second")],
				},
				{ name: "claude", target: "%3", kind: "coding-agent" },
			],
			focusedPane,
		});
	}

	it("moves between leaves inside a split window", () => {
		expect(cycleInSessionLeaf(split(0), 1).focusedPane).toBe(1);
	});

	it("wraps within the window rather than escaping to the next one", () => {
		// Escaping would make a two-pane split impossible to cycle: every second
		// press would leave the window the user is working in.
		const cycled = cycleInSessionLeaf(split(1), 1);
		expect(cycled.focusedPane).toBe(0);
		expect(cycled.focused).toBe(0);
	});

	it("shows the newly focused leaf's capture immediately", () => {
		// The captures are already in hand, so waiting for a refresh would blank
		// the pane for a frame on every keypress.
		expect(cycleInSessionLeaf(split(0), 1).capture).toBe("second");
	});

	it("cycles windows instead when the focused window is not split", () => {
		// One leaf is not a split, so the key means "next tab" — otherwise the
		// keypress does nothing at all and reads as dropped input.
		const view = panes({
			windows: [
				{ name: "a", target: "%1", kind: "coding-agent" },
				{ name: "b", target: "%2", kind: "coding-agent" },
			],
			focused: 0,
		});
		expect(cycleInSessionLeaf(view, 1).focused).toBe(1);
	});

	it("treats a single leaf as unsplit", () => {
		const view = panes({
			windows: [
				{
					name: "a",
					target: "%1",
					kind: "coding-agent",
					panes: [leaf("%1", 0, true)],
				},
				{ name: "b", target: "%2", kind: "coding-agent" },
			],
			focused: 0,
		});
		expect(cycleInSessionLeaf(view, 1).focused).toBe(1);
	});
});

describe("focusing a leaf directly", () => {
	function split(): InSessionPanes {
		return panes({
			windows: [
				{
					name: "codex",
					target: "%1",
					kind: "coding-agent",
					panes: [leaf("%1", 0, true), leaf("%2", 1, false)],
				},
			],
		});
	}

	it("tells tmux which pane to select", async () => {
		const tmux = fakeTmux({ "list-panes": { stdout: "%1\t0\t1\t80\t24" } });
		await focusInSessionLeaf(split(), tmux, 1);
		expect(tmux.calls[0]).toEqual(["select-pane", "-t", "%2"]);
	});

	it("clamps an index past the end to the last leaf", async () => {
		// The index comes from a UI that can be out of date with the split. Left
		// unclamped it reads undefined and the select is skipped entirely.
		const tmux = fakeTmux({ "list-panes": { stdout: "%1\t0\t1\t80\t24" } });
		await focusInSessionLeaf(split(), tmux, 99);
		expect(tmux.calls[0]).toEqual(["select-pane", "-t", "%2"]);
	});

	it("clamps a negative index to the first leaf", async () => {
		const tmux = fakeTmux({ "list-panes": { stdout: "%1\t0\t1\t80\t24" } });
		await focusInSessionLeaf(split(), tmux, -5);
		expect(tmux.calls[0]).toEqual(["select-pane", "-t", "%1"]);
	});

	it("does nothing when the focused window has no leaves", async () => {
		const tmux = fakeTmux();
		const view = panes({
			windows: [{ name: "codex", target: "%1", kind: "coding-agent" }],
		});
		expect(await focusInSessionLeaf(view, tmux, 0)).toBe(view);
		expect(tmux.calls).toEqual([]);
	});
});

describe("refreshing", () => {
	it("leaves a non-tmux view untouched", async () => {
		// Refreshing here would shell out on every tick in an environment that has
		// no tmux at all.
		const tmux = fakeTmux();
		const view = emptyInSessionPanes("no tmux");
		expect(await refreshInSessionPanes(view, tmux)).toBe(view);
		expect(tmux.calls).toEqual([]);
	});

	it("leaves a window-less view untouched", async () => {
		const tmux = fakeTmux();
		const view = panes();
		expect(await refreshInSessionPanes(view, tmux)).toBe(view);
	});

	it("re-reads the leaves of the focused window", async () => {
		const tmux = fakeTmux({
			"list-panes": { stdout: "%1\t0\t1\t80\t24\n%2\t1\t0\t80\t24" },
		});
		const view = panes({
			windows: [{ name: "codex", target: "%1", kind: "coding-agent" }],
		});
		const refreshed = await refreshInSessionPanes(view, tmux);
		expect(refreshed.windows[0]?.panes).toHaveLength(2);
	});

	it("retargets the window at its active leaf", async () => {
		// The window target is what later sends address. Pointing it at a pane
		// that is no longer active sends keys to a background split.
		const tmux = fakeTmux({
			"list-panes": { stdout: "%1\t0\t0\t80\t24\n%7\t1\t1\t80\t24" },
		});
		const view = panes({
			windows: [{ name: "codex", target: "%1", kind: "coding-agent" }],
		});
		const refreshed = await refreshInSessionPanes(view, tmux);
		expect(refreshed.windows[0]?.target).toBe("%7");
	});

	it("does not re-read leaves for unfocused windows", async () => {
		// Capturing every pane of every window on each tick is what the focused
		// index exists to avoid; a busy session would spend the whole frame on it.
		const tmux = fakeTmux({ "list-panes": { stdout: "%1\t0\t1\t80\t24" } });
		const view = panes({
			windows: [
				{ name: "a", target: "%1", kind: "coding-agent" },
				{ name: "b", target: "%2", kind: "coding-agent" },
			],
			focused: 0,
		});
		await refreshInSessionPanes(view, tmux);
		expect(tmux.calls.filter((call) => call[0] === "list-panes")).toHaveLength(
			1,
		);
	});

	it("clamps a focused leaf that the refresh made out of range", async () => {
		// Closing a pane is the ordinary way this happens. Unclamped, the index
		// keeps addressing a pane that is gone and the view renders blank.
		const tmux = fakeTmux({ "list-panes": { stdout: "%1\t0\t1\t80\t24" } });
		const view = panes({
			windows: [{ name: "codex", target: "%1", kind: "coding-agent" }],
			focusedPane: 5,
		});
		expect((await refreshInSessionPanes(view, tmux)).focusedPane).toBe(0);
	});

	it("captures the window directly when it reports no leaves", async () => {
		// A window with no listable panes still has content. Falling through to a
		// direct capture is what keeps it rendering rather than going blank.
		const tmux = fakeTmux({
			"list-panes": { code: 1 },
			"capture-pane": { stdout: "direct capture\n" },
		});
		const view = panes({
			windows: [{ name: "codex", target: "%1", kind: "coding-agent" }],
		});
		expect((await refreshInSessionPanes(view, tmux)).capture).toBe(
			"direct capture",
		);
	});
});
