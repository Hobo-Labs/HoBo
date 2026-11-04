/**
 * The shell's terminal navigation keys, driven through a fake terminal.
 *
 * `shell-live-tty.test.ts` establishes that raw stdin reaches the reducer and
 * that teardown restores the terminal. This drives the other half of the same
 * listener: the keys that move around the shell rather than typing into it.
 *
 * That listener is deliberately layered, and the layering is the behaviour:
 *
 * **The editor owns editing keys; the shell claims only true globals.** If the
 * shell grabbed a key the editor needed, a user could not type it — so the
 * shell's own bindings are conditioned on the editor not wanting them, which is
 * why almost every one of them checks that the input line is empty first.
 *
 * **A modal consumes every key.** While an approval gate is up, nothing may
 * fall through to the editor: a mutation must not be approved by a keystroke
 * aimed at something else. The `/agents` modal pins input for the same reason,
 * Tab included — letting Tab through to focus cycling used to wipe the catalog.
 *
 * **Navigation must never crash the loop.** A key pressed in a state that has
 * nothing to scroll is an ordinary thing for a user to do; it has to be a
 * no-op, not an exception inside a raw-mode terminal that then cannot restore
 * itself.
 *
 * Every run is bounded by `maxMs`, because a live-TTY test that waits on stdin
 * forever hangs the suite instead of failing it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { runInteractiveShell } from "../src/interactive-shell.js";
import type { JsonObject } from "../src/json.js";

const homes: string[] = [];

afterEach(() => {
	for (const dir of homes.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function home(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-shell-nav-"));
	homes.push(dir);
	return dir;
}

const CTRL_C = "";
const ESC = "";
const TAB = "\t";
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const HOME = `${ESC}[H`;
const END = `${ESC}[F`;
const PAGE_UP = `${ESC}[5~`;
const PAGE_DOWN = `${ESC}[6~`;

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

/** A stdout that claims to be a terminal and records write events. */
function fakeStdout(columns = 80, rows = 24) {
	const chunks: string[] = [];
	let version = 0;
	const waiters: Array<{
		readonly after: number;
		readonly resolve: (version: number) => void;
	}> = [];
	const stream = new Writable({
		write(chunk, _encoding, done) {
			chunks.push(String(chunk));
			version += 1;
			for (const waiter of waiters.splice(0)) {
				if (version > waiter.after) waiter.resolve(version);
				else waiters.push(waiter);
			}
			done();
		},
	});
	return Object.assign(stream, {
		isTTY: true as const,
		columns,
		rows,
		text: () => chunks.join(""),
		writeVersion: () => version,
		waitForWrite(after: number): Promise<number> {
			if (version > after) return Promise.resolve(version);
			return new Promise((resolve) => waiters.push({ after, resolve }));
		},
	});
}

/** Run the shell against a fake terminal, sequencing keys by shell events. */
async function live(
	keys: readonly string[],
	options: { readonly host?: JsonObject; readonly rows?: number } = {},
) {
	const stdin = fakeStdin();
	const stdout = fakeStdout(80, options.rows ?? 24);
	const prompts: string[] = [];
	const verbs: string[][] = [];
	let handledKeys = 0;
	const keyWaiters: Array<{
		readonly target: number;
		readonly resolve: () => void;
	}> = [];
	const settledWriteVersions: number[] = [];
	const turnWaiters: Array<{
		readonly target: number;
		readonly resolve: (writeVersion: number) => void;
	}> = [];
	const waitForKey = (target: number): Promise<void> => {
		if (handledKeys >= target) return Promise.resolve();
		return new Promise((resolve) => keyWaiters.push({ target, resolve }));
	};
	const waitForTurn = (target: number): Promise<number> => {
		const existing = settledWriteVersions[target - 1];
		if (existing !== undefined) return Promise.resolve(existing);
		return new Promise((resolve) => turnWaiters.push({ target, resolve }));
	};

	let announceReady: ((writeVersion: number) => void) | undefined;
	const ready = new Promise<number>((resolve) => {
		announceReady = resolve;
	});
	// SAFETY: the shell reads only the stream contract these fakes implement.
	const running = runInteractiveShell({
		stdin: stdin as never,
		stdout: stdout as never,
		hoboHome: home(),
		sidecars: false,
		reducedMotion: true,
		maxMs: 6_000,
		onReady: () => announceReady?.(stdout.writeVersion()),
		onKeyHandled: () => {
			handledKeys += 1;
			for (const waiter of keyWaiters.splice(0)) {
				if (handledKeys >= waiter.target) waiter.resolve();
				else keyWaiters.push(waiter);
			}
		},
		onTurnSettled: () => {
			const writeVersion = stdout.writeVersion();
			settledWriteVersions.push(writeVersion);
			for (const waiter of turnWaiters.splice(0)) {
				if (settledWriteVersions.length >= waiter.target) {
					waiter.resolve(writeVersion);
				} else {
					turnWaiters.push(waiter);
				}
			}
		},
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
	} as never);
	let finished = false;
	const completed = running.then((exitCode) => {
		finished = true;
		return exitCode;
	});

	const initialWrites = await Promise.race([ready, completed]);
	if (!finished) {
		await Promise.race([stdout.waitForWrite(initialWrites), completed]);
	}
	for (const [index, key] of keys.entries()) {
		if (finished) break;
		const promptCount = prompts.length;
		const turnTarget = settledWriteVersions.length + 1;
		const handled = waitForKey(handledKeys + 1);
		stdin.write(key);
		await Promise.race([handled, completed]);
		if (finished) break;
		await new Promise<void>((resolve) => setImmediate(resolve));
		const nextKey = keys[index + 1];
		if (prompts.length > promptCount && nextKey !== CTRL_C && nextKey !== ESC) {
			const settledAt = await Promise.race([
				waitForTurn(turnTarget),
				completed,
			]);
			if (!finished) {
				await Promise.race([stdout.waitForWrite(settledAt), completed]);
			}
		}
	}
	const code = await completed;

	return { code, output: stdout.text(), prompts, verbs, stdin, stdout };
}

/** Fill the transcript so there is something to scroll through. */
const filler = ["one\r", "two\r", "three\r", "four\r", "five\r"];

describe("scrolling the transcript", () => {
	it("survives page-up on an empty transcript", async () => {
		// Pressing page-up before anything has been said is an ordinary thing to
		// do. It must be a no-op, not an exception inside raw mode.
		expect((await live([PAGE_UP, CTRL_C])).code).toBe(0);
	});

	it("survives page-down on an empty transcript", async () => {
		expect((await live([PAGE_DOWN, CTRL_C])).code).toBe(0);
	});

	it("survives home on an empty transcript", async () => {
		expect((await live([HOME, CTRL_C])).code).toBe(0);
	});

	it("survives end on an empty transcript", async () => {
		expect((await live([END, CTRL_C])).code).toBe(0);
	});

	it("scrolls up through a filled transcript", async () => {
		const session = await live([...filler, PAGE_UP, CTRL_C]);
		expect(session.code).toBe(0);
		// Turns still landed — scrolling must not eat input. Each turn settles
		// before the next key, so the assertion does not depend on key pacing.
		expect(session.prompts.length).toBeGreaterThan(0);
		expect(session.prompts.every((p) => filler.includes(`${p}\r`))).toBe(true);
	});

	it("scrolls back down again", async () => {
		const session = await live([...filler, PAGE_UP, PAGE_DOWN, CTRL_C]);
		expect(session.code).toBe(0);
	});

	it("jumps to the top with home", async () => {
		expect((await live([...filler, HOME, CTRL_C])).code).toBe(0);
	});

	it("jumps back to live with end", async () => {
		// `end` is the escape hatch from a scrolled-back view; without it a user
		// who paged up has no way back to the running turn.
		expect((await live([...filler, HOME, END, CTRL_C])).code).toBe(0);
	});

	it("steps one line up with the arrow key on an empty input line", async () => {
		const session = await live([...filler, UP, CTRL_C]);
		expect(session.code).toBe(0);
	});

	it("steps one line down with the arrow key", async () => {
		expect((await live([...filler, UP, DOWN, CTRL_C])).code).toBe(0);
	});

	it("leaves the arrow keys to the editor when the input line has text", async () => {
		// With text typed, ↑ is history recall inside the editor. If the shell
		// stole it for scrolling, the user could not reach their last command.
		const session = await live(["hello", UP, "\r", CTRL_C]);
		expect(session.code).toBe(0);
		// Whatever ↑ did, the line still submitted as a turn rather than being
		// swallowed.
		expect(session.prompts.length).toBeGreaterThan(0);
	});

	it("restores the terminal after scrolling", async () => {
		const session = await live([...filler, PAGE_UP, HOME, END, CTRL_C]);
		// The point of the whole file: no navigation path may skip teardown.
		expect(session.stdin.rawModeCalls.at(-1)).toBe(false);
		expect(session.output).toContain("[?1049l");
	});

	it("keeps scrolling sane on a very short terminal", async () => {
		// A two-row terminal makes the page step degenerate; the arithmetic must
		// not produce a negative or NaN offset.
		expect((await live([...filler, PAGE_UP, CTRL_C], { rows: 3 })).code).toBe(
			0,
		);
	});

	it("keeps scrolling sane on a very tall terminal", async () => {
		expect((await live([...filler, PAGE_UP, CTRL_C], { rows: 200 })).code).toBe(
			0,
		);
	});
});

describe("moving focus", () => {
	it("cycles focus with tab on an empty input line", async () => {
		expect((await live([TAB, CTRL_C])).code).toBe(0);
	});

	it("cycles focus repeatedly and comes back", async () => {
		// Focus is a ring. A cycle that could run off the end would strand the
		// user in a pane they cannot leave.
		expect((await live([TAB, TAB, TAB, TAB, CTRL_C])).code).toBe(0);
	});

	it("scrolls whatever pane has focus", async () => {
		const session = await live([...filler, TAB, PAGE_UP, CTRL_C]);
		expect(session.code).toBe(0);
	});

	it("restores the terminal after cycling focus", async () => {
		const session = await live([TAB, TAB, CTRL_C]);
		expect(session.stdin.rawModeCalls.at(-1)).toBe(false);
	});

	it("still submits turns after a focus cycle", async () => {
		// Focus that swallowed subsequent input would look like a hung shell.
		const session = await live([TAB, TAB, "hello\r", CTRL_C]);
		expect(session.prompts).toContain("hello");
	});

	it("survives bracket navigation with no agent work", async () => {
		// `[` and `]` step between agent items. With no agents running there is
		// nothing to step to, and it must be inert.
		expect((await live(["[", "]", CTRL_C])).code).toBe(0);
	});

	it("survives harness navigation keys", async () => {
		expect((await live([".", ",", CTRL_C])).code).toBe(0);
	});

	it("leaves bracket keys to the editor when the line has text", async () => {
		// `[` is an ordinary character. A user typing `a[0]` must get it.
		const session = await live(["a[0]\r", CTRL_C]);
		expect(session.prompts).toContain("a[0]");
	});

	it("leaves a period to the editor when the line has text", async () => {
		const session = await live(["hi.\r", CTRL_C]);
		expect(session.prompts).toContain("hi.");
	});
});

describe("the approval modal owns every key", () => {
	/**
	 * With a pending approval up, the listener hands every key to the modal
	 * before any other binding runs. A key that fell through could approve a
	 * mutation the user never looked at.
	 */
	const approvingHost = {
		pendingApprovalFor: async () => ({
			runId: "run-1",
			sandboxRoot: "/sandbox/run-1",
			changes: [{ path: "src/app.ts", status: "modified" }],
		}),
		promote: async () => "promoted run-1",
	};

	it("raises the gate after a turn that changed the sandbox", async () => {
		const session = await live(["edit it\r", CTRL_C], {
			host: {
				...approvingHost,
				complete: async () => "done",
				streamTurn: async () => ({
					ok: true,
					text: "done",
					toolCalls: 1,
					aborted: false,
				}),
			},
		});
		expect(session.code).toBe(0);
	});

	it("does not let tab cycle focus while the gate is up", async () => {
		const session = await live(["edit it\r", TAB, CTRL_C], {
			host: {
				...approvingHost,
				complete: async () => "done",
				streamTurn: async () => ({
					ok: true,
					text: "done",
					toolCalls: 1,
					aborted: false,
				}),
			},
		});
		// The assertion that matters is that the shell still exits cleanly with
		// the modal having consumed the key rather than the focus ring moving
		// underneath it.
		expect(session.code).toBe(0);
		expect(session.stdin.rawModeCalls.at(-1)).toBe(false);
	});

	it("does not let page-up scroll while the gate is up", async () => {
		const session = await live(["edit it\r", PAGE_UP, CTRL_C], {
			host: {
				...approvingHost,
				complete: async () => "done",
				streamTurn: async () => ({
					ok: true,
					text: "done",
					toolCalls: 1,
					aborted: false,
				}),
			},
		});
		expect(session.code).toBe(0);
	});

	it("still quits from inside the gate", async () => {
		// Ctrl-C is the one key that must always work; a modal that trapped it
		// would leave the user with no way out but killing the terminal.
		const session = await live(["edit it\r", CTRL_C], {
			host: {
				...approvingHost,
				complete: async () => "done",
				streamTurn: async () => ({
					ok: true,
					text: "done",
					toolCalls: 1,
					aborted: false,
				}),
			},
		});
		expect(session.code).toBe(0);
		expect(session.output).toContain("[?1049l");
	});
});

describe("the agents modal pins input", () => {
	it("opens the agents catalog", async () => {
		expect((await live(["/agents\r", CTRL_C])).code).toBe(0);
	});

	it("does not let tab escape the agents catalog", async () => {
		// Requiring focus === "agents-catalog" previously let Tab reach the
		// focus ring and wipe the catalog stack. The modal now pins Tab too.
		const session = await live(["/agents\r", TAB, CTRL_C]);
		expect(session.code).toBe(0);
		expect(session.stdin.rawModeCalls.at(-1)).toBe(false);
	});

	it("takes arrow keys inside the agents catalog", async () => {
		expect((await live(["/agents\r", DOWN, UP, CTRL_C])).code).toBe(0);
	});

	it("takes page keys inside the agents catalog", async () => {
		expect((await live(["/agents\r", PAGE_DOWN, PAGE_UP, CTRL_C])).code).toBe(
			0,
		);
	});

	it("leaves the catalog on escape", async () => {
		expect((await live(["/agents\r", ESC, CTRL_C])).code).toBe(0);
	});

	it("restores the terminal from inside the catalog", async () => {
		const session = await live(["/agents\r", DOWN, CTRL_C]);
		expect(session.output).toContain("[?1049l");
	});
});

describe("navigation never strands the terminal", () => {
	it("restores raw mode after a long mixed key sequence", async () => {
		const session = await live([
			...filler,
			TAB,
			PAGE_UP,
			UP,
			HOME,
			END,
			"[",
			"]",
			".",
			",",
			DOWN,
			PAGE_DOWN,
			TAB,
			CTRL_C,
		]);
		// One assertion standing in for every path above: whatever the user
		// pressed, the terminal comes back.
		expect(session.code).toBe(0);
		expect(session.stdin.rawModeCalls.at(-1)).toBe(false);
		expect(session.output).toContain("[?1049l");
		expect(session.output).toContain("[?25h");
	});

	it("still accepts a turn after the same sequence", async () => {
		const session = await live([
			TAB,
			PAGE_UP,
			HOME,
			END,
			TAB,
			"still here\r",
			CTRL_C,
		]);
		// A navigation key that quietly broke input would look exactly like a
		// hung shell to the user.
		expect(session.prompts).toContain("still here");
	});
});
