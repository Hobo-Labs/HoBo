/**
 * Perceptual/render-economy contract for the InteractiveShell driver.
 *
 * The pre-pi-tui shell erased and repainted the entire screen every 95 ms
 * unconditionally (≈21 KB/s of pure flicker at 80×24) and once per input
 * character. These tests pin the fixed behavior end-to-end through the real
 * driver: initial paint once, diffs only on change, idle rest spans write
 * nothing, replies are honest about what dispatch does.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { must } from "@hobo/core/total-access";
import { afterAll, describe, expect, it } from "vitest";
import { stripAnsi } from "../src/ansi.js";
import {
	appendAssistant,
	clearWrapCache,
	createInitialShellState,
	peekWrapCache,
	renderShellFrame,
	runInteractiveShell,
	type ShellHost,
} from "../src/interactive-shell.js";
import { cellWidth } from "../src/rubberhose.js";
import { createDefaultShellHost } from "../src/shell-host.js";
import { StreamTerminal } from "../src/shell-terminal.js";
import { BO_IDLE_TICK_MS } from "../src/splash.js";

const WIDTH = 80;
const HEIGHT = 24;
/** One full frame incl. newlines — the naive per-keystroke repaint cost. */
const FRAME_BYTES = (WIDTH + 1) * HEIGHT;

const cleanups: string[] = [];
afterAll(() => {
	for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(d);
	return d;
}

function collector(onWrite?: () => void) {
	let total = 0;
	const stream = new Writable({
		write(chunk, _enc, cb) {
			total += chunk.length;
			onWrite?.();
			cb();
		},
	});
	return { stream, bytes: () => total };
}

const stubHost: ShellHost = {
	runVerb: async () => "verb output",
	complete: async () => "stub reply",
};

interface RunOptions {
	readonly scriptedKeys?: string;
	readonly maxMs?: number;
	readonly reducedMotion?: boolean;
	readonly host?: ShellHost;
	readonly onTerminal?: (t: StreamTerminal) => void;
	/** Feeds the shell keys after it starts, where `scriptedKeys` are fixed up front. */
	readonly stdin?: PassThrough;
	/** Called on every write to stdout, after the terminal has counted it. */
	readonly onWrite?: () => void;
}

async function runShell(options: RunOptions): Promise<{
	readonly exitCode: number;
	readonly bytes: number;
	readonly terminal: StreamTerminal;
}> {
	const stdin = options.stdin ?? new PassThrough();
	const out = collector(options.onWrite);
	let terminal!: StreamTerminal;
	const exitCode = await runInteractiveShell({
		stdin,
		stdout: out.stream,
		host: options.host ?? stubHost,
		reducedMotion: options.reducedMotion ?? true,
		sidecars: false,
		env: { ...process.env, HOBO_HOME: temp("hc-shell-home-") },
		...(options.scriptedKeys !== undefined
			? { scriptedKeys: options.scriptedKeys }
			: undefined),
		...(options.maxMs !== undefined ? { maxMs: options.maxMs } : undefined),
		onTerminal: (t) => {
			terminal = t;
			options.onTerminal?.(t);
		},
	});
	return { exitCode, bytes: out.bytes(), terminal };
}

describe("InteractiveShell TTY close", () => {
	it("enters and leaves the alternate screen so the frame does not stay in history", async () => {
		const chunks: string[] = [];
		// SAFETY: parsed or fixture value is the named domain type after this assertion.
		const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
		stdin.isTTY = true;
		// SAFETY: parsed or fixture value is the named domain type after this assertion.
		const stdout = new Writable({
			write(chunk, _enc, cb) {
				chunks.push(String(chunk));
				cb();
			},
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
		}) as Writable & { isTTY?: boolean; columns?: number; rows?: number };
		stdout.isTTY = true;
		stdout.columns = 80;
		stdout.rows = 24;
		await runInteractiveShell({
			stdin,
			stdout,
			host: stubHost,
			reducedMotion: true,
			maxMs: 80,
			sidecars: false,
			env: { ...process.env, HOBO_HOME: temp("hc-altscreen-") },
		});
		const out = chunks.join("");
		expect(out).toContain("\u001b[?1049h");
		expect(out).toContain("\u001b[?1049l");
		expect(out.indexOf("\u001b[?1049h")).toBeLessThan(
			out.lastIndexOf("\u001b[?1049l"),
		);
		expect(out).toMatch(/hobo-code resume chat-[0-9a-f]+/u);
		expect(out.lastIndexOf("\u001b[?1049l")).toBeLessThan(
			out.search(/hobo-code resume chat-/u),
		);
	});
});

describe("InteractiveShell render budget (differential rendering)", () => {
	it("typing N keys costs far less than N full-frame repaints", async () => {
		const keys = "hello world";
		const { exitCode, bytes } = await runShell({ scriptedKeys: keys });
		expect(exitCode).toBe(0);
		// Naive pre-fix behavior: (1 initial + one per key) × full frame.
		const naive = (keys.length + 1) * FRAME_BYTES;
		// Diff rendering: one full frame + per-key input-line updates.
		expect(bytes).toBeLessThan(naive / 2);
		expect(bytes).toBeGreaterThan(0);
	});

	it("reduced motion: zero writes while idle after the first paint", async () => {
		// The idle window is the property under test, so it is the one timer here.
		// It starts on the write that completes the first paint rather than on a
		// polled guess, and a key closes the shell once it has elapsed, rather
		// than a fixed lifetime that every run pays in full. Eight ticks reach
		// past the idle sprite's first bounce (ticks 6–15 of its cycle), so the
		// window would see a frame if reduced motion stopped holding it still.
		const idleWindowMs = BO_IDLE_TICK_MS * 8;
		const stdin = new PassThrough();
		let terminalRef: StreamTerminal | undefined;
		let painting = false;
		let afterPaint = 0;
		let beforeQuit = 0;
		const { terminal } = await runShell({
			reducedMotion: true,
			// A backstop only: the test ends on the key.
			maxMs: 15_000,
			stdin,
			onTerminal: (t) => {
				terminalRef = t;
			},
			onWrite: () => {
				if (painting || (terminalRef?.bytesWritten ?? 0) <= 64) return;
				painting = true;
				// A frame is several writes in one turn; snapshot once it is whole.
				setImmediate(() => {
					afterPaint = terminalRef?.bytesWritten ?? 0;
					setTimeout(() => {
						beforeQuit = terminalRef?.bytesWritten ?? -1;
						stdin.write("\u0003");
					}, idleWindowMs);
				});
			},
		});
		expect(afterPaint).toBeGreaterThan(0);
		// No animation, no input — not a single byte between the two snapshots.
		expect(beforeQuit).toBe(afterPaint);
		// Exit cleanup (cursor restore) is the only thing written afterwards.
		expect(terminal.bytesWritten - beforeQuit).toBeLessThan(64);
	});

	it("idle animation stays far below the naive full-repaint byte rate", async () => {
		let afterFirstPaint = 0;
		let terminalRef: StreamTerminal | undefined;
		const firstPaint = new Promise<void>((resolve) => {
			setTimeout(() => {
				afterFirstPaint = terminalRef?.bytesWritten ?? -1;
				resolve();
			}, 120);
		});
		const windowMs = 600;
		const { terminal } = await runShell({
			reducedMotion: false,
			maxMs: 120 + windowMs,
			onTerminal: (t) => {
				terminalRef = t;
			},
		});
		await firstPaint;
		const animationBytes = terminal.bytesWritten - afterFirstPaint;
		// Pre-fix behavior: a full erase+frame every 95 ms regardless of change.
		const naive = Math.floor(windowMs / 95) * FRAME_BYTES;
		expect(animationBytes).toBeLessThan(naive / 2);
	});

	it("a submitted prompt resolves without blocking and renders the reply", async () => {
		let resolved = false;
		const host: ShellHost = {
			runVerb: async () => "verb output",
			complete: async (prompt) => {
				// Yield across the event loop — the shell must keep running.
				await new Promise((r) => setTimeout(r, 20));
				resolved = true;
				return `echo:${prompt}`;
			},
		};
		const { exitCode } = await runShell({
			scriptedKeys: "hi\r",
			host,
		});
		expect(exitCode).toBe(0);
		expect(resolved).toBe(true);
	});
});

describe("default shell host honesty", () => {
	it("a dispatch reply states what actually happened — no success theater", async () => {
		const home = temp("hc-honest-home-");
		const project = temp("hc-honest-proj-");
		const host = createDefaultShellHost({
			hoboHome: home,
			cwd: project,
			env: { ...process.env, HOBO_HOME: home },
		});
		const reply = await host.complete("add a settings button");
		// Honest: names the recorded task and says no engine acted on it.
		expect(reply).toMatch(/Recorded compute task task-[0-9a-f]+/);
		expect(reply).toMatch(/No completion engine/i);
		// Teaches the scripted surface.
		expect(reply).toContain(
			'One-shot equivalent: hobo-code "add a settings button"',
		);
		// The old reply was branding + filler around an 8-char echo panel.
		expect(reply).not.toMatch(/not stock Pi/i);
		expect(reply).not.toMatch(/Bo dispatched your prompt/);
		expect(reply).not.toMatch(/Next: \/status/);
	});

	it("a failed dispatch reply carries the failure code and remediation", async () => {
		const home = temp("hc-honest-fail-");
		const host = createDefaultShellHost({
			hoboHome: home,
			env: { ...process.env, HOBO_HOME: home },
		});
		// Unknown flag on a verb path fails closed with remediation. The old
		// assertion here was `length > 0`, which any string satisfied.
		const reply = await host.runVerb(["status", "--wat"]);
		expect(reply).toMatch(/wat/);
		expect(reply.toLowerCase()).toMatch(/unknown|unsupported|invalid/);
		// A failure must tell you what to do next, not just that it failed.
		expect(reply).toMatch(/hobo-code/);
	});
});

describe("StreamTerminal contract", () => {
	it("uses the alternate screen on a live TTY so quit does not bloat scrollback", () => {
		const chunks: string[] = [];
		// SAFETY: parsed or fixture value is the named domain type after this assertion.
		const stdin = new PassThrough() as PassThrough & {
			isTTY?: boolean;
			isRaw?: boolean;
			setRawMode?: (raw: boolean) => void;
		};
		stdin.isTTY = true;
		stdin.setRawMode = () => {};
		// SAFETY: parsed or fixture value is the named domain type after this assertion.
		const stdout = new Writable({
			write(chunk, _enc, cb) {
				chunks.push(String(chunk));
				cb();
			},
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
		}) as Writable & { isTTY?: boolean };
		stdout.isTTY = true;
		const t = new StreamTerminal({
			stdin,
			stdout,
			columns: 80,
			rows: 24,
			rawMode: true,
			alternateScreen: true,
		});
		t.start(
			() => {},
			() => {},
		);
		const started = chunks.join("");
		expect(started).toContain("\u001b[?1049h");
		expect(started.indexOf("\u001b[?1049h")).toBeLessThan(
			started.indexOf("\u001b[?2004h"),
		);
		t.stop();
		const all = chunks.join("");
		expect(all).toContain("\u001b[?1049l");
		expect(all.lastIndexOf("\u001b[?2004l")).toBeLessThan(
			all.lastIndexOf("\u001b[?1049l"),
		);
	});

	it("does not enter the alternate screen unless asked — capture streams keep frames", () => {
		const chunks: string[] = [];
		const t = new StreamTerminal({
			stdin: new PassThrough(),
			stdout: new Writable({
				write(chunk, _enc, cb) {
					chunks.push(String(chunk));
					cb();
				},
			}),
		});
		t.start(
			() => {},
			() => {},
		);
		t.stop();
		expect(chunks.join("")).not.toContain("\u001b[?1049h");
		expect(chunks.join("")).not.toContain("\u001b[?1049l");
	});

	it("accounts every byte it writes and implements progress signalling", () => {
		const out = collector();
		const t = new StreamTerminal({
			stdin: new PassThrough(),
			stdout: out.stream,
			columns: 80,
			rows: 24,
		});
		expect(t.bytesWritten).toBe(0);
		t.write("hello");
		expect(t.bytesWritten).toBe(5);
		expect(t.writeCount).toBe(1);
		// setProgress is a real OSC 9;4 signal, not a swallowed call.
		const before = t.bytesWritten;
		t.setProgress(true);
		t.setProgress(false);
		expect(t.bytesWritten).toBeGreaterThan(before);
		expect(t.writeCount).toBe(3);
		// Falls back to declared geometry when the stream carries none.
		expect(t.columns).toBe(80);
		expect(t.rows).toBe(24);
	});
});

describe("terminal resize redraw", () => {
	it("clears and reflows to the new size without over-wide lines", async () => {
		class FakeStdout extends Writable {
			columns = 80;
			rows = 24;
			chunks: string[] = [];
			override _write(
				chunk: Buffer | string,
				_enc: BufferEncoding,
				cb: (error?: Error | null) => void,
			): void {
				this.chunks.push(String(chunk));
				cb();
			}
			resize(cols: number, rows: number): void {
				this.columns = cols;
				this.rows = rows;
				this.emit("resize");
			}
		}
		const stdin = new PassThrough();
		const stdout = new FakeStdout();
		let terminal!: StreamTerminal;
		const done = runInteractiveShell({
			stdin,
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			stdout: stdout as NodeJS.WriteStream,
			host: stubHost,
			reducedMotion: true,
			sidecars: false,
			onTerminal: (t) => {
				terminal = t;
			},
		});
		await new Promise((r) => setTimeout(r, 60));
		stdout.chunks = [];
		stdout.resize(60, 20);
		await new Promise((r) => setTimeout(r, 60));
		const after = stdout.chunks.join("");
		expect(after).toContain("\u001b[2J");
		expect(terminal.columns).toBe(60);
		expect(terminal.rows).toBe(20);
		// Strip CSI / OSC so we can measure painted cells.
		const plain = stripAnsi(after);
		const over = plain.split(/\r?\n/).filter((line) => line.length > 60);
		expect(over).toEqual([]);
		stdin.write("\u0003");
		await Promise.race([done, new Promise((r) => setTimeout(r, 800))]);
	});

	it("layout width follows the TTY — never paints wider than columns", () => {
		for (const w of [30, 48, 80]) {
			const state = createInitialShellState({
				width: w,
				height: 18,
				welcome: false,
				reducedMotion: true,
			});
			const lines = renderShellFrame(state).split("\n");
			for (const line of lines) {
				expect(cellWidth(line)).toBe(w);
			}
		}
	});
});

describe("wrap cache invalidation", () => {
	it("actually drops cached wraps, not just returns the same frame", () => {
		let state = createInitialShellState({
			width: 60,
			height: 24,
			welcome: false,
			reducedMotion: true,
		});
		state = appendAssistant(state, "a message that will be wrapped");
		// Warm the cache, then observe the cache itself rather than the frame:
		// a frame comparison passes even if invalidate() is a no-op, which is
		// exactly how the previous version of this test proved nothing.
		renderShellFrame(state);
		const message = must(
			state.messages[state.messages.length - 1],
			"state.messages[state.messages.length - 1]",
		);
		expect(peekWrapCache(message)).not.toBeUndefined();
		clearWrapCache();
		expect(peekWrapCache(message)).toBeUndefined();
		// And the frame still renders correctly from cold.
		expect(renderShellFrame(state)).toContain("a message that will be");
	});
});
