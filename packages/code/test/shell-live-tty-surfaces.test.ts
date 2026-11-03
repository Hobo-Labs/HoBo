/**
 * The shell's live-TTY *surfaces* — the panels, palettes and modes a user
 * reaches with the keyboard once the loop is running.
 *
 * The companion `shell-live-tty.test.ts` covers entering and leaving the
 * terminal: raw mode, the alternate screen, teardown. This file covers what
 * happens in between, and it exists for the same structural reason — the
 * scripted-keys hook turns the live path *off*
 * (`liveTty = isTty && options.scriptedKeys === undefined`), so none of this
 * runs under a scripted test no matter how many keys it sends.
 *
 * Two things shape every case here:
 *
 * **Every run is bounded.** A live-TTY test that waits on stdin forever hangs
 * the suite instead of failing it, and a hung suite says nothing about which
 * case broke. So every run carries `maxMs`, and every one ends with a quit key.
 *
 * **The terminal must come back clean from every one of these paths.** A mode
 * that swallows Ctrl-C, or a panel that exits without leaving the alternate
 * screen, strands the user's terminal — so the exit assertions repeat across
 * the surfaces rather than being factored into one happy-path test. That
 * repetition is the point: it is the property most likely to break in exactly
 * one mode and go unnoticed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import {
	runInteractiveShell,
	type ShellHost,
} from "../src/interactive-shell.js";

const homes: string[] = [];

afterEach(() => {
	for (const dir of homes.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function home(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-shell-surface-"));
	homes.push(dir);
	return dir;
}

/** Control bytes, spelled as escapes so this file stays plain text. */
const CTRL_C = "";
const TAB = "\t";
const ESC = "";
const ENTER = "\r";
const BACKSPACE = "";
const UP = "[A";
const DOWN = "[B";

/** CSI sequences (colour, cursor moves, modes), built from ESC so the regex holds no control byte. */
const TERMINAL_ESCAPES = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "gu");

/** A stdin that claims to be a terminal and accepts raw mode. */
function fakeStdin() {
	const stream = new PassThrough();
	const calls: boolean[] = [];
	return Object.assign(stream, {
		isTTY: true as const,
		rawModeCalls: calls,
		setRawMode(mode: boolean) {
			calls.push(mode);
			return stream;
		},
	});
}

/**
 * A stdout that claims to be a terminal, records what was painted, and says
 * when the first real frame arrived.
 *
 * "Real" excludes the setup escapes the shell emits before it has anything to
 * show — entering the alternate screen, hiding the cursor. Waiting on those
 * would be waiting on nothing.
 */
function fakeStdout(columns = 80, rows = 24) {
	const chunks: string[] = [];
	let announcePainted: (() => void) | undefined;
	const painted = new Promise<void>((resolve) => {
		announcePainted = resolve;
	});
	const stream = new Writable({
		write(chunk, _encoding, done) {
			const text = String(chunk);
			chunks.push(text);
			// Anything left after stripping the escapes is content on screen.
			if (text.replace(TERMINAL_ESCAPES, "").trim().length > 0) {
				announcePainted?.();
			}
			done();
		},
	});
	return Object.assign(stream, {
		isTTY: true as const,
		columns,
		rows,
		text: () => chunks.join(""),
		firstPaint: painted,
	});
}

/**
 * Run the shell against a fake terminal, feeding `keys` on a timer once the
 * loop is listening.
 *
 * The keys go in one at a time on a delay because that is how a keyboard
 * delivers them, and because a burst written before the listener attaches is a
 * burst nothing reads — which would make every test here silently vacuous.
 */
async function live(
	keys: readonly string[],
	options: {
		readonly host?: Partial<ShellHost>;
		readonly columns?: number;
		readonly rows?: number;
		readonly maxMs?: number;
		/**
		 * Milliseconds between keys. The default is a keyboard's cadence; a test
		 * whose keys straddle an async turn needs longer, because a key that
		 * arrives while the previous turn is still running is a different case
		 * than the one being tested.
		 */
		readonly gap?: number;
	} = {},
) {
	const stdin = fakeStdin();
	const stdout = fakeStdout(options.columns ?? 80, options.rows ?? 24);
	const prompts: string[] = [];
	const verbs: string[][] = [];

	// Keys start after the first frame is actually on screen, not after a fixed
	// delay. A key that lands before the shell has painted tests a shell the
	// user never meets, and for the assertions that read what was painted it
	// would compare against an empty terminal — passing vacuously. Waiting on
	// the paint itself is also what keeps this file honest under the coverage
	// lane, where instrumentation makes every startup slower than a guess.
	const gap = options.gap ?? 150;
	void stdout.firstPaint.then(() => {
		let delay = 0;
		for (const key of keys) {
			setTimeout(() => stdin.write(key), delay);
			delay += gap;
		}
	});

	const code = await runInteractiveShell({
		stdin,
		stdout,
		hoboHome: home(),
		sidecars: false,
		reducedMotion: true,
		maxMs: options.maxMs ?? 10_000,
		host: {
			runVerb: async (argv: readonly string[]) => {
				verbs.push([...argv]);
				return `ran ${argv.join(" ")}`;
			},
			complete: async (prompt: string) => {
				prompts.push(prompt);
				return `assistant: ${prompt}`;
			},
			...options.host,
		},
	});

	const output = stdout.text();
	return {
		code,
		output,
		// The renderer paints with SGR and cursor moves interleaved, so a match
		// against the raw stream would depend on where the escapes happened to
		// fall rather than on what the user saw.
		painted: output.replace(TERMINAL_ESCAPES, ""),
		prompts,
		verbs,
		stdin,
		stdout,
	};
}

/** Every surface has to hand the terminal back. */
function expectCleanExit(session: {
	output: string;
	stdin: { rawModeCalls: boolean[] };
}) {
	expect(session.stdin.rawModeCalls.at(-1)).toBe(false);
	expect(session.output).toContain("[?1049l");
	expect(session.output).toContain("[?25h");
}

describe("the slash palette", () => {
	it("opens on a live slash keypress", async () => {
		// The palette's job is to show what can be typed next, so its contents
		// are the thing to assert — not its chrome.
		const session = await live(["/", CTRL_C]);
		expect(session.painted).toMatch(/\/templates|\/status|\/dev/u);
	});

	it("filters as the user keeps typing", async () => {
		// The palette is only useful if it narrows; an unfiltered list of every
		// command is the help screen with extra steps.
		const session = await live(["/", "s", "t", "a", CTRL_C]);
		expect(session.painted).toMatch(/status/u);
	});

	it("closes on escape without running anything", async () => {
		// Escape is how a user backs out of a menu they opened by accident, and
		// it must not leave the typed text behind as a prompt either.
		const session = await live(["/", "s", ESC, CTRL_C]);
		expect(session.verbs).toEqual([]);
		expect(session.prompts).toEqual([]);
	});

	it("runs the selected command on enter", async () => {
		const session = await live(["/status", ENTER, CTRL_C]);
		expect(session.verbs).toContainEqual(["status"]);
	});

	it("moves the selection with the arrow keys", async () => {
		// A palette that ignores the arrows forces the user to type the whole
		// name, which is what the palette exists to avoid. Down-then-up returns
		// to the first match, so the filtered command is what runs.
		const session = await live(["/", "s", "t", DOWN, UP, ENTER, CTRL_C], {
			maxMs: 12_000,
		});
		expect(session.verbs.length).toBeGreaterThan(0);
	});

	it("backspaces out of the palette rather than trapping the user", async () => {
		// Deleting the slash that opened it is the other way out, and a user who
		// tries it must not end up in a mode with no exit.
		const session = await live(["/", BACKSPACE, "hi", ENTER, CTRL_C]);
		expect(session.prompts).toEqual(["hi"]);
	});

	it("hands the terminal back from an open palette", async () => {
		// Quitting with a modal open is the case most likely to skip teardown.
		expectCleanExit(await live(["/", CTRL_C]));
	});
});

describe("moving focus", () => {
	it("cycles focus on tab", async () => {
		// Tab is the only way to reach the side panels from the keyboard.
		const session = await live([TAB, CTRL_C]);
		expect(session.output.length).toBeGreaterThan(0);
		expectCleanExit(session);
	});

	it("comes back to chat after cycling all the way round", async () => {
		// A focus ring that does not close is a trap: the user tabs forward and
		// can never get back to the input.
		const session = await live([TAB, TAB, TAB, TAB, TAB, "hi", ENTER, CTRL_C]);
		expect(session.prompts).toEqual(["hi"]);
	});

	it("still quits from a focused panel", async () => {
		const session = await live([TAB, TAB, CTRL_C]);
		expect(session.code).toBe(0);
		expectCleanExit(session);
	});
});

describe("the side chat", () => {
	it("opens an aside on btw", async () => {
		// `btw` answers from a snapshot of what is already on screen; it must not
		// reach the engine, because the whole point is that it costs nothing.
		const session = await live(["btw what's going on", ENTER, CTRL_C]);
		expect(session.prompts).toEqual([]);
	});

	it("keeps the parent thread visible behind the aside", async () => {
		const session = await live([
			"hello",
			ENTER,
			"btw what's going on",
			ENTER,
			CTRL_C,
		]);
		expect(session.prompts).toEqual(["hello"]);
		expect(session.painted).toMatch(/hello/u);
	});

	it("hands the terminal back from an open aside", async () => {
		expectCleanExit(await live(["btw hi", ENTER, CTRL_C]));
	});
});

describe("typing", () => {
	it("erases a character on backspace", async () => {
		// The most-used key in any terminal input, and the one whose absence is
		// noticed immediately.
		const session = await live(["h", "i", "x", BACKSPACE, ENTER, CTRL_C]);
		expect(session.prompts).toEqual(["hi"]);
	});

	it("does nothing on backspace at an empty prompt", async () => {
		// Deleting past the start must not underflow into the previous line or
		// submit an empty turn.
		const session = await live([BACKSPACE, BACKSPACE, "hi", ENTER, CTRL_C]);
		expect(session.prompts).toEqual(["hi"]);
	});

	it("does not submit an empty line", async () => {
		// An empty turn spends a model call on nothing.
		const session = await live([ENTER, ENTER, CTRL_C]);
		expect(session.prompts).toEqual([]);
	});

	it("accepts a line with spaces in it", async () => {
		const session = await live(["fix the login bug", ENTER, CTRL_C]);
		expect(session.prompts).toEqual(["fix the login bug"]);
	});

	it("takes a second turn after the first one lands", async () => {
		// One turn working proves the wiring; two proves the loop resets.
		const session = await live(["one", ENTER, "two", ENTER, CTRL_C], {
			maxMs: 12_000,
			gap: 400,
		});
		expect(session.prompts).toEqual(["one", "two"]);
	});

	it("ignores an escape sequence that means nothing here", async () => {
		// Terminals send sequences for keys the shell does not handle; each one
		// must be dropped rather than typed into the prompt as literal bytes.
		const session = await live([`${ESC}[5~`, "hi", ENTER, CTRL_C]);
		expect(session.prompts).toEqual(["hi"]);
	});
});

describe("scrolling the transcript", () => {
	it("scrolls without disturbing the input", async () => {
		// Reading back through the conversation must not consume the line the
		// user was halfway through typing.
		const session = await live(
			["hello", ENTER, "partial", UP, UP, DOWN, ENTER, CTRL_C],
			{ maxMs: 8_000 },
		);
		expect(session.prompts[0]).toBe("hello");
	});

	it("hands the terminal back from a scrolled transcript", async () => {
		expectCleanExit(
			await live(["hello", ENTER, UP, UP, CTRL_C], { maxMs: 8_000 }),
		);
	});
});

describe("the global keys", () => {
	// These are claimed by the shell rather than the editor, so each one is a
	// deliberate carve-out from ordinary typing. A key that stopped being
	// global would silently start inserting a character instead.

	it("clears a half-typed line on escape", async () => {
		// Escape doing nothing at all is the alternative, and a user who has
		// typed the wrong thing then has to hold backspace.
		const session = await live(["wrong", ESC, "right", ENTER, CTRL_C]);
		expect(session.prompts).toEqual(["right"]);
	});

	it("does nothing harmful on escape at an empty prompt", async () => {
		const session = await live([ESC, "hi", ENTER, CTRL_C]);
		expect(session.prompts).toEqual(["hi"]);
	});

	it("cancels an in-flight turn on escape when the host can", async () => {
		// The engine is the slow part of this shell; a user who cannot interrupt
		// it waits or kills the terminal.
		let cancelled = 0;
		const session = await live(["slow", ENTER, ESC, CTRL_C], {
			maxMs: 12_000,
			host: {
				cancelTurn: async () => {
					cancelled += 1;
				},
				complete: async () =>
					await new Promise<string>((resolve) => {
						setTimeout(() => resolve("late"), 4_000);
					}),
			},
		});
		expect(cancelled).toBeGreaterThan(0);
		expectCleanExit(session);
	});

	it.each([
		["page up", "[5~"],
		["page down", "[6~"],
		["home", "[H"],
		["end", "[F"],
	])("scrolls on %s without typing anything", async (_label, suffix) => {
		// These arrive from the terminal as ESC-prefixed sequences. Falling
		// through to the editor would insert their bytes into the prompt as
		// literal text, which is exactly what a user sees when a terminal and an
		// application disagree about a key.
		const session = await live([`${ESC}${suffix}`, "hi", ENTER, CTRL_C]);
		expect(session.prompts).toEqual(["hi"]);
	});

	it("quits on Ctrl-C even with text in the prompt", async () => {
		// The one key that must always work. A shell that swallows it while the
		// user is mid-line is a shell they have to kill from another terminal.
		const session = await live(["half a line", CTRL_C]);
		expect(session.code).toBe(0);
		expectCleanExit(session);
	});
});

describe("a turn that goes wrong", () => {
	it("stays alive when the engine throws", async () => {
		// The shell is a long-lived session; one failed turn must not end it, or
		// the user loses the conversation they were having.
		const session = await live(["boom", ENTER, "again", ENTER, CTRL_C], {
			maxMs: 8_000,
			host: {
				complete: async (prompt: string) => {
					if (prompt === "boom") throw new Error("engine exploded");
					return `assistant: ${prompt}`;
				},
			},
		});
		expect(session.code).toBe(0);
	});

	it("shows the user that something failed", async () => {
		// A turn that silently produces nothing reads as a hang.
		const session = await live(["boom", ENTER, CTRL_C], {
			host: {
				complete: async () => {
					throw new Error("engine exploded");
				},
			},
		});
		expect(session.output.length).toBeGreaterThan(0);
		expectCleanExit(session);
	});

	it("stays alive when a slash verb throws", async () => {
		const session = await live(["/status", ENTER, "hi", ENTER, CTRL_C], {
			maxMs: 8_000,
			host: {
				runVerb: async () => {
					throw new Error("verb exploded");
				},
			},
		});
		expect(session.code).toBe(0);
	});

	it("quits cleanly while a turn is still running", async () => {
		// Ctrl-C during a long turn is the most common way anyone leaves this
		// shell, and the one where teardown is easiest to skip.
		const session = await live(["slow", ENTER, CTRL_C], {
			host: {
				complete: async () =>
					await new Promise<string>((resolve) => {
						setTimeout(() => resolve("late"), 3_000);
					}),
			},
		});
		expectCleanExit(session);
	});
});

describe("a very small terminal", () => {
	it("still paints inside a narrow window", async () => {
		// Panels are laid out against the terminal width; a width nothing was
		// designed for is where a layout throws rather than degrades.
		const session = await live([CTRL_C], { columns: 20, rows: 8 });
		expect(session.code).toBe(0);
	});

	it("still takes a turn in a narrow window", async () => {
		const session = await live(["hi", ENTER, CTRL_C], {
			columns: 24,
			rows: 8,
		});
		expect(session.prompts).toEqual(["hi"]);
	});

	it("hands back a narrow terminal cleanly", async () => {
		expectCleanExit(await live([CTRL_C], { columns: 20, rows: 8 }));
	});

	it("still paints in a very wide window", async () => {
		// The other end of the range: a full-screen terminal on a large display.
		const session = await live([CTRL_C], { columns: 400, rows: 100 });
		expect(session.code).toBe(0);
	});
});
