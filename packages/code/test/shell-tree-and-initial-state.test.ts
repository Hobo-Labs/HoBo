/**
 * The two pure functions the whole shell is built out of.
 *
 * `createInitialShellState` decides what the first frame contains before the
 * user has done anything, and `buildShellTree` picks which surface that frame
 * shows. Both are exported and pure, which is what makes the rest of the shell
 * testable — every reducer test in this directory starts from one and every
 * render ends at the other.
 *
 * **`buildShellTree` is a priority ladder, and the order is the contract.**
 * Transcript mode wins, then a pending approval, then the slash palette, then
 * the agents surfaces, then status and resources, then chat. Each rung exists
 * because the one below it would otherwise hide something modal: an approval
 * that lost to the chat pane would be a gate the user cannot see but is still
 * answering, and a palette that lost to the agents pane would leave the user
 * typing a filter into an invisible list.
 *
 * **Every surface says where it is scrolled to.** The title carries `↑N` once
 * the pane is scrolled back, because a scrolled pane and a short pane look
 * identical otherwise — the user cannot tell "there is more above" from "that
 * is all of it".
 *
 * **`createInitialShellState` clamps the terminal size.** A width of 0 comes
 * from a terminal that has not reported yet, and every layout calculation
 * downstream divides or subtracts by it.
 */
import { describe, expect, it } from "vitest";

import {
	buildShellTree,
	createInitialShellState,
	type InteractiveShellState,
	type PendingApproval,
	type ShellMessage,
} from "../src/interactive-shell.js";

const base = (overrides: Partial<InteractiveShellState> = {}) =>
	// SAFETY: the fixture is the state shape the builders are declared over.
	({
		...createInitialShellState({ width: 80, height: 24, welcome: false }),
		...overrides,
		// SAFETY: the fixture is the state shape the builders are declared over.
	}) as InteractiveShellState;

const message = (text: string): ShellMessage => ({
	role: "assistant",
	text,
	at: 1,
});

const approval: PendingApproval = {
	runId: "run-7",
	sandboxRoot: "/tmp/sandbox",
	changes: [{ status: "M", path: "src/thing.ts" }],
};

/**
 * The title the tree was built with. It lives on a nested node rather than the
 * root, so it is read back out of the serialised tree -- the alternative is
 * walking a node type this test has no business knowing the shape of.
 */
const titleOf = (state: InteractiveShellState): string =>
	/"title":"([^"]*)"/.exec(JSON.stringify(buildShellTree(state)))?.[1] ?? "";

const treeText = (state: InteractiveShellState) =>
	JSON.stringify(buildShellTree(state));

describe("the size the shell starts at", () => {
	it("takes the terminal's own width", () => {
		expect(createInitialShellState({ width: 120, height: 40 }).width).toBe(120);
	});

	it("takes the terminal's own height", () => {
		expect(createInitialShellState({ width: 120, height: 40 }).height).toBe(40);
	});

	it("clamps a zero width up to something usable", () => {
		// A width of 0 comes from a terminal that has not reported yet, and
		// every layout calculation downstream subtracts insets from it -- a
		// zero would produce negative widths and an unrenderable frame.
		expect(
			createInitialShellState({ width: 0, height: 24 }).width,
		).toBeGreaterThan(0);
	});

	it("clamps a zero height up to something usable", () => {
		expect(
			createInitialShellState({ width: 80, height: 0 }).height,
		).toBeGreaterThan(0);
	});

	it("clamps an absurd width down", () => {
		// Wrapping every message to 100,000 columns is not a rendering anyone
		// wants; it is also a lot of string work per frame.
		expect(
			createInitialShellState({ width: 100_000, height: 24 }).width,
		).toBeLessThan(1_000);
	});

	it("clamps an absurd height down", () => {
		expect(
			createInitialShellState({ width: 80, height: 100_000 }).height,
		).toBeLessThan(1_000);
	});

	it("falls back to a sane default when given no size", () => {
		const state = createInitialShellState({});
		expect(state.width).toBeGreaterThan(0);
		expect(state.height).toBeGreaterThan(0);
	});
});

describe("what the first frame starts with", () => {
	it("starts focused on the chat", () => {
		// Chat is first -- the product's stated shape. Starting anywhere else
		// would put a user's first keystroke into a pane they did not choose.
		expect(createInitialShellState({}).focus).toBe("chat");
	});

	it("starts with an empty composer", () => {
		expect(createInitialShellState({}).input).toBe("");
	});

	it("starts with the slash palette closed", () => {
		expect(createInitialShellState({}).slashOpen).toBe(false);
	});

	it("starts with no approval pending", () => {
		// A gate on the first frame would ask the user to approve something
		// that cannot exist yet.
		expect(createInitialShellState({}).pendingApproval).toBeNull();
	});

	it("starts outside transcript reading mode", () => {
		expect(createInitialShellState({}).transcriptMode).toBeNull();
	});

	it("starts at the live end of the chat", () => {
		expect(createInitialShellState({}).chatScroll).toBe(0);
	});

	it("starts with no session id", () => {
		// Recorded as observed. The id is minted when the chat is first
		// persisted, not when the state is constructed -- which is why
		// `/resume` on an untouched shell still prints one: the running loop
		// has already persisted by then. A state that invented an id here
		// would name a journal that does not exist yet.
		expect(createInitialShellState({}).sessionId).toBeNull();
	});

	it("takes messages it is handed, for a resumed chat", () => {
		// Resuming is the whole reason this is a parameter: a resumed session
		// has to open showing what was already said.
		const state = createInitialShellState({
			messages: [message("from an earlier session")],
		});
		expect(state.messages).toHaveLength(1);
	});

	it("shows a welcome when asked", () => {
		expect(
			createInitialShellState({ welcome: true }).messages.length,
		).toBeGreaterThan(0);
	});

	it("shows none when not", () => {
		// A scripted or resumed session does not want a welcome banner between
		// it and the transcript.
		expect(createInitialShellState({ welcome: false }).messages).toStrictEqual(
			[],
		);
	});

	it("reads reduced motion from the environment", () => {
		// An accessibility setting: someone who set it in their shell profile
		// should not also have to pass a flag.
		expect(
			createInitialShellState({
				hoboHome: process.env.HOBO_HOME,
				env: { HOBO_CODE_REDUCED_MOTION: "1" },
			}).reducedMotion,
		).toBe(true);
	});

	it("accepts the word true as well as the digit", () => {
		expect(
			createInitialShellState({
				hoboHome: process.env.HOBO_HOME,
				env: { HOBO_CODE_REDUCED_MOTION: "true" },
			}).reducedMotion,
		).toBe(true);
	});

	it("does not read an unrelated value as enabled", () => {
		// `0`, `false`, and anything else mean off. Treating a non-empty string
		// as truthy would enable it for someone who explicitly turned it off.
		expect(
			createInitialShellState({
				hoboHome: process.env.HOBO_HOME,
				env: { HOBO_CODE_REDUCED_MOTION: "0" },
			}).reducedMotion,
		).toBe(false);
	});

	it("takes the explicit option over the environment", () => {
		expect(
			createInitialShellState({
				reducedMotion: true,
				env: {},
				hoboHome: process.env.HOBO_HOME,
			}).reducedMotion,
		).toBe(true);
	});
});

describe("which surface the frame shows", () => {
	it("shows the chat by default", () => {
		expect(titleOf(base())).toBe("chat");
	});

	it("shows the palette when it is open", () => {
		expect(titleOf(base({ slashOpen: true, slashFilter: "" }))).toBe(
			"commands",
		);
	});

	it("shows the approval gate over the chat", () => {
		// A gate that lost to the chat pane would be something the user is
		// answering without being able to see it.
		expect(titleOf(base({ pendingApproval: approval }))).toMatch(/promote/);
	});

	it("names the run being approved", () => {
		// "Approve?" without saying what is the definition of a blind consent
		// dialog.
		expect(titleOf(base({ pendingApproval: approval }))).toContain("run-7");
	});

	it("shows the approval gate over the palette", () => {
		// Both are modal; the gate outranks, because leaving a palette on top
		// would let a keystroke dismiss the palette and hit the gate behind it.
		expect(
			titleOf(base({ pendingApproval: approval, slashOpen: true })),
		).toMatch(/promote/);
	});

	it("shows transcript mode over everything", () => {
		// The top rung. A reading view that lost to a modal would strand the
		// user inside something they opened to read their way out of.
		expect(
			titleOf(
				base({
					transcriptMode: { offset: 0 },
					pendingApproval: approval,
					slashOpen: true,
				}),
			),
		).toMatch(/transcript/);
	});

	it("labels transcript mode as a less-style view", () => {
		// The label sets the key expectations: j/k, g/G, q to leave.
		expect(titleOf(base({ transcriptMode: { offset: 0 } }))).toContain("less");
	});

	it("shows the status pane when it has focus", () => {
		expect(titleOf(base({ focus: "status" }))).toMatch(/status/);
	});

	it("shows the resources pane when it has focus", () => {
		expect(titleOf(base({ focus: "resources" }))).toMatch(/resources/);
	});

	it("shows the agents pane when it has focus", () => {
		expect(treeText(base({ focus: "agents" })).length).toBeGreaterThan(0);
	});

	it("explains an empty agents pane rather than showing a blank box", () => {
		// A blank pane reads as broken. This one says what would fill it and
		// what to do to get there.
		expect(treeText(base({ focus: "agents" }))).toMatch(
			/no harness sessions yet/,
		);
	});

	it("keeps the chat first in the empty-agents copy", () => {
		expect(treeText(base({ focus: "agents" }))).toMatch(/chat stays first/);
	});
});

describe("saying where a pane is scrolled to", () => {
	it("marks a scrolled status pane", () => {
		// A scrolled pane and a short pane look identical without this: the
		// user cannot tell "there is more above" from "that is all of it".
		expect(titleOf(base({ focus: "status", paneScroll: 12 }))).toContain("↑12");
	});

	it("does not mark an unscrolled status pane", () => {
		// The marker has to mean something; showing ↑0 on every frame would
		// train the reader to ignore it.
		expect(titleOf(base({ focus: "status", paneScroll: 0 }))).not.toContain(
			"↑",
		);
	});

	it("marks a scrolled resources pane", () => {
		expect(titleOf(base({ focus: "resources", paneScroll: 3 }))).toContain(
			"↑3",
		);
	});

	it("does not mark an unscrolled resources pane", () => {
		expect(titleOf(base({ focus: "resources", paneScroll: 0 }))).not.toContain(
			"↑",
		);
	});

	it("marks a scrolled approval gate", () => {
		// The one that matters most: the changes list is what is being
		// approved, and not knowing there is more of it above is how someone
		// approves a diff they only saw half of.
		expect(
			titleOf(base({ pendingApproval: approval, paneScroll: 5 })),
		).toContain("↑5");
	});

	it("does not mark an unscrolled approval gate", () => {
		expect(
			titleOf(base({ pendingApproval: approval, paneScroll: 0 })),
		).not.toContain("↑");
	});

	it("still names the run on a scrolled gate", () => {
		// The scroll marker must not push out the identity.
		expect(
			titleOf(base({ pendingApproval: approval, paneScroll: 5 })),
		).toContain("run-7");
	});
});

describe("the tree survives awkward states", () => {
	it("builds with no messages at all", () => {
		expect(treeText(base({ messages: [] })).length).toBeGreaterThan(0);
	});

	it("builds at the narrowest allowed width", () => {
		// The clamp floor. Every inset subtraction has to still leave a
		// positive content width here.
		const state = base({
			...createInitialShellState({ width: 1, height: 24, welcome: false }),
		});
		expect(treeText(state).length).toBeGreaterThan(0);
	});

	it("builds at the shortest allowed height", () => {
		const state = base({
			...createInitialShellState({ width: 80, height: 1, welcome: false }),
		});
		expect(treeText(state).length).toBeGreaterThan(0);
	});

	it("builds with a chat scroll past the end", () => {
		// The scroll is clamped at render rather than trusted; a stale offset
		// from a resize would otherwise index past the transcript.
		expect(
			treeText(base({ messages: [message("one")], chatScroll: 9_999 })).length,
		).toBeGreaterThan(0);
	});

	it("builds with a transcript offset past the end", () => {
		expect(
			treeText(
				base({ messages: [message("one")], transcriptMode: { offset: 9_999 } }),
			).length,
		).toBeGreaterThan(0);
	});

	it("builds with a palette filter that matches nothing", () => {
		// An empty list is a legitimate state -- the user is mid-typo -- and it
		// has to render as an empty palette rather than throw.
		expect(
			treeText(base({ slashOpen: true, slashFilter: "reticulate" })).length,
		).toBeGreaterThan(0);
	});

	it("builds with a palette index past the filtered list", () => {
		expect(
			treeText(base({ slashOpen: true, slashFilter: "help", slashIndex: 99 }))
				.length,
		).toBeGreaterThan(0);
	});

	it("builds with a very long single message", () => {
		// One pasted stack trace should not be able to break the frame.
		expect(
			treeText(base({ messages: [message("x".repeat(20_000))] })).length,
		).toBeGreaterThan(0);
	});

	it("builds with a message containing no spaces to wrap on", () => {
		// Word wrapping has no break opportunity here; a naive wrapper loops
		// forever or produces zero-width lines.
		expect(
			treeText(base({ messages: [message("x".repeat(500))] })).length,
		).toBeGreaterThan(0);
	});

	it("is stable across two builds of the same state", () => {
		// It is called on every keystroke and diffed against the previous
		// frame; a non-deterministic tree would repaint the whole screen every
		// time.
		const state = base({ messages: [message("hello")] });
		expect(treeText(state)).toBe(treeText(state));
	});

	it("does not mutate the state it was given", () => {
		// It reassigns `state` internally to sync derived rows; that must not
		// escape to the caller holding the previous frame.
		const state = base({ focus: "agents" });
		const before = state.focus;
		buildShellTree(state);
		expect(state.focus).toBe(before);
	});
});
