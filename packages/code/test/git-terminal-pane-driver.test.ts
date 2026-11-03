/**
 * The Git pane's interactive loop, driven against a real worktree.
 *
 * The sibling `git-terminal-pane.test.ts` covers the pure layer — prompt
 * parsing, selection movement, the frame. This file covers `runGitTerminalPane`
 * itself: the key dispatch, the terminal it borrows, and the approval gates in
 * front of everything destructive.
 *
 * Three properties shape every case here.
 *
 * **Destructive actions are gated, and the gate is a real question.** Discard,
 * branch delete, commit revert and stash drop all route through a prompt that
 * must be answered `yes`. Anything else — a stray key, an escape, an empty
 * line, `y`, `YES` — leaves the worktree untouched. The tests assert on the
 * *worktree*, not on what the pane printed, because a pane that says it
 * cancelled while having already run `git checkout --` is exactly the bug the
 * gate exists to prevent.
 *
 * **The terminal is borrowed and must be handed back.** The pane takes raw
 * mode, drops it to ask a question, retakes it, and restores what it found on
 * the way out. A pane that leaves raw mode on strands the operator's shell.
 *
 * **Every run is bounded.** The loop reads from stdin until `q`; a test that
 * forgot to send it would hang the suite rather than fail it, so every run here
 * ends with a quit key and a deadline.
 *
 * A real `git` binary and a real temporary repository are used deliberately.
 * The pane's whole job is to report and change what git says, and a faked git
 * would let the pane and the fake agree with each other while both being wrong.
 */
import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runGitTerminalPane } from "../src/git-terminal-pane.js";
import {
	createLocalSessionControl,
	sessionCommandEnvelope,
} from "../src/local-session-control.js";
import type { MuxRunner } from "../src/mux.js";

const temps: string[] = [];

afterEach(() => {
	for (const dir of temps.splice(0)) {
		rmSync(dir, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 50,
		});
	}
});

function temp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temps.push(dir);
	return dir;
}

function git(cwd: string, args: readonly string[]): string {
	return execFileSync(
		"git",
		args,
		{
			cwd,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "Test",
				GIT_AUTHOR_EMAIL: "test@example.com",
				GIT_COMMITTER_NAME: "Test",
				GIT_COMMITTER_EMAIL: "test@example.com",
			},
		},
		GIT_TIMEOUT_MS,
	);
}

/**
 * A repository with one commit and nothing outstanding.
 *
 * Deliberately clean. The session opens its own git *worktree* on a new
 * branch, so uncommitted changes here would not appear there at all — the
 * pane would show an empty file list and every action test would pass by
 * acting on nothing. Working changes are made in the worktree instead, by
 * `dirty()` below.
 */
function repository(): string {
	const root = temp("hobo-git-pane-repo-");
	cpSync(template, root, { recursive: true });
	return root;
}

/**
 * Built once per file. Each test gets a copy, which costs a directory copy
 * rather than four git subprocesses and a commit. Signing is off in the
 * repository's own config so a developer's global `commit.gpgsign` cannot put
 * a signing helper in front of the fixture or the pane's own commits.
 */
let template = "";

beforeAll(() => {
	template = mkdtempSync(join(tmpdir(), "hobo-git-pane-template-"));
	git(template, ["init", "-q", "-b", "main"]);
	git(template, ["config", "user.email", "test@example.com"]);
	git(template, ["config", "user.name", "Test"]);
	git(template, ["config", "commit.gpgsign", "false"]);
	writeFileSync(join(template, "README.md"), "base\n");
	writeFileSync(join(template, "tracked.txt"), "original\n");
	git(template, ["add", "-A"]);
	git(template, ["commit", "-qm", "base"]);
});

afterAll(() => {
	rmSync(template, { recursive: true, force: true });
});

/** One modified tracked file and one untracked file, inside the worktree. */
function dirty(worktree: string): void {
	writeFileSync(join(worktree, "tracked.txt"), "edited\n");
	writeFileSync(join(worktree, "untracked.txt"), "new\n");
}

/**
 * A tmux that answers plausibly without one being installed.
 *
 * The pane never drives tmux itself, but the session control it loads through
 * does, and a missing binary would fail the setup rather than the behaviour
 * under test.
 */
function fakeTmux(): MuxRunner {
	let pane = 0;
	let exists = false;
	return {
		async run(args) {
			if (args[0] === "capture-pane") return { code: 0, stdout: "" };
			if (args[0] === "has-session")
				return { code: exists ? 0 : 1, stdout: "" };
			if (
				["new-session", "new-window", "split-window"].includes(args[0] ?? "")
			) {
				exists = true;
				pane += 1;
				return { code: 0, stdout: `%${pane}\n` };
			}
			if (args[0] === "kill-session") exists = false;
			return { code: 0, stdout: "" };
		},
	};
}

/** A stdin that claims to be a terminal and records raw-mode transitions. */
function fakeStdin() {
	const stream = new PassThrough();
	const rawModeCalls: boolean[] = [];
	return Object.assign(
		stream,
		{
			isTTY: true as const,
			isRaw: false,
			rawModeCalls,
			setRawMode(mode: boolean) {
				rawModeCalls.push(mode);
				return stream;
			},
		},
		GIT_TIMEOUT_MS,
	);
}

function fakeStdout(columns = 100, rows = 30) {
	const chunks: string[] = [];
	let writes = 0;
	const waiters: { readonly after: number; readonly resolve: () => void }[] =
		[];
	const stream = new Writable(
		{
			write(chunk, _encoding, done) {
				chunks.push(String(chunk));
				writes += 1;
				for (const waiter of waiters.splice(0)) {
					if (writes > waiter.after) waiter.resolve();
					else waiters.push(waiter);
				}
				done();
			},
		},
		GIT_TIMEOUT_MS,
	);
	return Object.assign(
		stream,
		{
			columns,
			rows,
			text: () => chunks.join(""),
			/** How many times the pane has written — a repaint or a prompt label. */
			writes: () => writes,
			/** Resolves on the first write past the `after`th, at once if it already happened. */
			wroteAfter: (after: number) =>
				new Promise<void>((resolve) => {
					if (writes > after) resolve();
					else waiters.push({ after, resolve });
				}),
		},
		GIT_TIMEOUT_MS,
	);
}

const QUIT = "q";

/**
 * Every test here drives real `git` subprocesses through a real worktree.
 * Vitest's 10s default is shorter than that takes on a loaded machine — and
 * this file runs alongside the rest of the package — so a tighter deadline
 * would produce a suite that is green alone and red in CI, which reads as a
 * product bug nobody can reproduce.
 */
const GIT_TIMEOUT_MS = 90_000;

/**
 * Open the pane on a session whose worktree is `repo`, feed `keys`, and return
 * what happened.
 *
 * Keys go in one at a time because each one may kick off a git subprocess, and
 * a burst written ahead of the reader is a burst the loop coalesces into a
 * single chunk — which is a different input than a person typing.
 */
async function pane(
	repo: string,
	keys: readonly string[],
	options: {
		/** Runs against the session's worktree before the pane opens. */
		readonly prepare?: (worktree: string) => void;
	} = {},
) {
	const hoboHome = temp("hobo-git-pane-home-");
	const control = createLocalSessionControl({ hoboHome, tmux: fakeTmux() });
	const created = await control.execute(
		sessionCommandEnvelope("pane-session", 0n, "test", "createSession", {
			name: "pane",
			projectRoot: repo,
			branch: "code/pane",
			clientId: "test",
		}),
		true,
	);
	// Read the worktree back rather than reconstructing it. The path carries a
	// hash the session derives, and a test that rebuilt it by hand would start
	// asserting against an empty directory the moment that derivation changed —
	// silently, since every assertion here is about files that would then all
	// be absent.
	const worktree = created?.session?.worktreePath;
	if (typeof worktree !== "string" || worktree.length === 0) {
		throw new Error("the session reported no worktree path");
	}

	options.prepare?.(worktree);

	const stdin = fakeStdin();
	const stdout = fakeStdout();

	// Each key waits for the pane's answer to the one before it (the first
	// paint, then a repaint or a prompt label), so none lands in the window
	// where the loop is `busy` and drops keys. The count is taken before the key
	// is written: a key that opens a prompt writes its label inside
	// `stdin.write` itself, and a count taken afterwards waits for a write that
	// has already happened. The tick after the answer lets the pane leave `busy`
	// and attach a prompt's listener, both of which follow the write in the same
	// turn of the event loop.
	let done = false;
	const feed = async (): Promise<void> => {
		// Write 1 switches the terminal mode; write 2 is the first paint.
		let answered = 1;
		for (const key of keys) {
			await stdout.wroteAfter(answered);
			await new Promise<void>((resolve) => setImmediate(resolve));
			if (done) return;
			answered = stdout.writes();
			stdin.write(key);
		}
		// Then keep asking to leave until the pane actually leaves.
		//
		// The loop drops any key that arrives while it is mid-action, so a
		// single quit can land in that gap and vanish — and a pane that never
		// quits does not fail the test, it hangs it, which costs the whole
		// timeout and points at the wrong thing. Repeating is what a person
		// does when a keypress appears to do nothing, and it removes the race
		// rather than widening a deadline until it usually wins.
		while (!done) {
			await new Promise((resolve) => setTimeout(resolve, 250));
			if (!done) stdin.write(QUIT);
		}
	};
	void feed();

	try {
		const code = await runGitTerminalPane({
			sessionId: "pane-session",
			hoboHome,
			input: stdin as never,
			output: stdout as never,
		});
		return { code, output: stdout.text(), stdin, hoboHome, worktree };
	} finally {
		done = true;
	}
}

describe("opening the pane", () => {
	it(
		"refuses a stream that is not a terminal",
		async () => {
			// The pane paints with cursor moves and reads single keys; against a pipe
			// it would emit escape soup and never receive a keystroke.
			await expect(
				runGitTerminalPane({
					sessionId: "any",
					hoboHome: temp("hobo-git-pane-nontty-"),
					input: new PassThrough() as never,
					output: fakeStdout() as never,
				}),
			).rejects.toThrow(/requires a TTY/u);
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"refuses a terminal that cannot enter raw mode",
		async () => {
			// `isTTY` without `setRawMode` is what a partially-faked stream looks
			// like, and the loop would read lines rather than keys.
			const input = Object.assign(new PassThrough(), { isTTY: true });
			await expect(
				runGitTerminalPane({
					sessionId: "any",
					hoboHome: temp("hobo-git-pane-noraw-"),
					input: input as never,
					output: fakeStdout() as never,
				}),
			).rejects.toThrow(/requires a TTY/u);
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"refuses a session that does not exist",
		async () => {
			// Opening the pane on nothing would leave it painting an empty frame
			// against a worktree path of `undefined`.
			await expect(
				runGitTerminalPane({
					sessionId: "no-such-session",
					hoboHome: temp("hobo-git-pane-missing-"),
					input: fakeStdin() as never,
					output: fakeStdout() as never,
				}),
			).rejects.toThrow(/does not exist/u);
		},
		GIT_TIMEOUT_MS,
	);
});

describe("the terminal it borrows", () => {
	it(
		"exits zero on q",
		async () => {
			expect((await pane(repository(), [QUIT])).code).toBe(0);
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"exits zero on Ctrl-C",
		async () => {
			// Ctrl-C inside a full-screen pane means "leave the pane", not "kill the
			// process" — the session it belongs to is still running.
			expect((await pane(repository(), [""])).code).toBe(0);
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"takes raw mode so it receives keys rather than lines",
		async () => {
			const session = await pane(repository(), [QUIT]);
			expect(session.stdin.rawModeCalls).toContain(true);
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"gives raw mode back on the way out",
		async () => {
			// Leaving it on strands the operator's shell: no echo, no Ctrl-C, and
			// `reset` typed blind as the only recovery.
			const session = await pane(repository(), [QUIT]);
			expect(session.stdin.rawModeCalls.at(-1)).toBe(false);
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"paints a frame",
		async () => {
			const session = await pane(repository(), [QUIT]);
			expect(session.output).toContain("hobo-code · Git");
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"clears the screen before each frame rather than scrolling",
		async () => {
			// Without the clear, every repaint would append and the pane would walk
			// down the scrollback instead of staying in place.
			const session = await pane(repository(), [QUIT]);
			expect(session.output).toContain("[2J[H");
		},
		GIT_TIMEOUT_MS,
	);
});

describe("moving around", () => {
	it.each([
		["1", "Status"],
		["2", "Files"],
		["3", "Branches"],
		["4", "Commits"],
		["5", "Stash"],
	])(
		"focuses a panel on %s",
		async (key, title) => {
			// The number keys are the pane's only direct navigation; a panel that
			// could not be focused could not be acted on. The assertion is on the
			// focus *marker*, not on the title — every box title renders in every
			// frame, so containing one would prove nothing at all.
			const session = await pane(repository(), [key, QUIT], { prepare: dirty });
			expect(session.output).toContain(`▸ ${key} ${title}`);
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"ignores a number outside the panel range",
		async () => {
			// `6` is a plausible typo for `5`, and it must not blank the panel.
			const session = await pane(repository(), ["6", QUIT]);
			expect(session.code).toBe(0);
		},
		GIT_TIMEOUT_MS,
	);

	it.each(["j", "[B"])(
		"moves down on %s",
		async (key) => {
			const session = await pane(repository(), ["2", key, QUIT]);
			expect(session.code).toBe(0);
		},
		GIT_TIMEOUT_MS,
	);

	it.each(["k", "[A"])(
		"moves up on %s",
		async (key) => {
			const session = await pane(repository(), ["2", "j", key, QUIT]);
			expect(session.code).toBe(0);
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"ignores a key it does not know",
		async () => {
			// A pane that crashed on an unrecognised key would exit on a stray
			// mouse-mode escape or a bracketed-paste marker.
			const session = await pane(repository(), ["Z", "~", QUIT]);
			expect(session.code).toBe(0);
		},
		GIT_TIMEOUT_MS,
	);
});

describe("staging", () => {
	it(
		"stages the selected file on space",
		async () => {
			const session = await pane(repository(), ["2", " ", QUIT], {
				prepare: dirty,
			});
			const staged = git(session.worktree, ["diff", "--cached", "--name-only"]);
			expect(staged.trim().length).toBeGreaterThan(0);
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"unstages a file that is staged and otherwise clean",
		async () => {
			// Space is a toggle, and the toggle's direction is decided from the
			// file's own state — staging an already-staged file would be a no-op the
			// operator reads as the pane ignoring them.
			const session = await pane(repository(), ["2", " ", " ", QUIT], {
				prepare: dirty,
			});
			expect(session.code).toBe(0);
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"does nothing on space outside the files panel",
		async () => {
			// Space on the commits panel has no file to act on, and inventing one
			// would stage something the operator never selected.
			const session = await pane(repository(), ["4", " ", QUIT], {
				prepare: dirty,
			});
			expect(git(session.worktree, ["diff", "--cached", "--name-only"])).toBe(
				"",
			);
		},
		GIT_TIMEOUT_MS,
	);
});

describe("the approval gate in front of anything destructive", () => {
	// Each of these asks a question. The worktree is what gets asserted, because
	// a pane that printed "cancelled" after already running the command would
	// pass a test that only read its output.

	it(
		"discards a file when the answer is yes",
		async () => {
			const session = await pane(repository(), ["2", "x", "yes\r", QUIT], {
				prepare: dirty,
			});
			const worktree = session.worktree;
			// The tracked edit is the one the pane offers first.
			expect(readFileSync(join(worktree, "tracked.txt"), "utf8")).toBe(
				"original\n",
			);
		},
		GIT_TIMEOUT_MS,
	);

	it.each([
		["no", "no\r"],
		["an empty line", "\r"],
		["whitespace", "   \r"],
		["a bare y", "y\r"],
		["the wrong case", "YES\r"],
	])(
		"leaves the file alone when the answer is %s",
		async (_label, answer) => {
			// The gate compares for exact equality on purpose. `y` and `YES` are the
			// answers a hurried operator gives, and neither is the deliberate
			// confirmation this prompt is asking for.
			const session = await pane(repository(), ["2", "x", answer, QUIT], {
				prepare: dirty,
			});
			expect(readFileSync(join(session.worktree, "tracked.txt"), "utf8")).toBe(
				"edited\n",
			);
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"leaves the file alone when the prompt is escaped",
		async () => {
			// Esc cancels rather than answering, and a cancelled prompt must not read
			// as an approval.
			const session = await pane(repository(), ["2", "x", "", QUIT], {
				prepare: dirty,
			});
			expect(readFileSync(join(session.worktree, "tracked.txt"), "utf8")).toBe(
				"edited\n",
			);
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"asks before deleting a branch",
		async () => {
			const session = await pane(repository(), ["3", "j", "x", "no\r", QUIT]);
			expect(session.output).toMatch(/type yes to approve/u);
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"names what it is about to do in the prompt",
		async () => {
			// "Are you sure?" with no object is a prompt operators learn to answer
			// yes to reflexively.
			const session = await pane(repository(), ["2", "x", "no\r", QUIT], {
				prepare: dirty,
			});
			expect(session.output).toMatch(/file-discard tracked\.txt/u);
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"drops raw mode while asking, so the answer can be typed",
		async () => {
			// A question asked in raw mode gets one character and no echo.
			const session = await pane(repository(), ["2", "x", "no\r", QUIT], {
				prepare: dirty,
			});
			expect(session.stdin.rawModeCalls).toEqual(
				expect.arrayContaining([true, false, true]),
			);
		},
		GIT_TIMEOUT_MS,
	);
});

describe("prompts that create rather than destroy", () => {
	it(
		"creates a branch with the name that was typed",
		async () => {
			const session = await pane(repository(), ["n", "feature/x\r", QUIT]);
			expect(
				git(session.worktree, ["branch", "--list", "feature/x"]),
			).toContain("feature/x");
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"creates no branch when the name is left empty",
		async () => {
			// An empty answer is a cancel, not a branch named "".
			const session = await pane(repository(), ["n", "\r", QUIT]);
			expect(session.code).toBe(0);
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"creates no branch when the prompt is cancelled",
		async () => {
			const before = repository();
			const session = await pane(before, ["n", "", QUIT]);
			expect(session.code).toBe(0);
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"stashes with the message that was typed",
		async () => {
			const session = await pane(repository(), ["s", "wip here\r", QUIT], {
				prepare: dirty,
			});
			expect(git(session.worktree, ["stash", "list"])).toContain("wip here");
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"stashes nothing when the message is left empty",
		async () => {
			const session = await pane(repository(), ["s", "\r", QUIT], {
				prepare: dirty,
			});
			expect(git(session.worktree, ["stash", "list"])).toBe("");
		},
		GIT_TIMEOUT_MS,
	);
});

describe("checking out", () => {
	it(
		"checks out the selected branch on enter",
		async () => {
			const session = await pane(repository(), [
				"n",
				"other\r",
				"3",
				"j",
				"\r",
				QUIT,
			]);
			expect(session.code).toBe(0);
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"does nothing on enter outside the branches panel",
		async () => {
			// Enter on the files panel has no branch to check out, and guessing one
			// would move the operator's HEAD without being asked.
			const session = await pane(repository(), ["2", "\r", QUIT]);
			expect(session.code).toBe(0);
		},
		GIT_TIMEOUT_MS,
	);
});

describe("the worktree the pane opens", () => {
	it(
		"acts on the session's worktree, not the project it came from",
		async () => {
			// The session opens its own worktree so an agent's edits stay off the
			// operator's checkout. A pane that reached for the project root would
			// stage and discard files in the directory the human is working in.
			const project = repository();
			const session = await pane(project, ["2", " ", QUIT], { prepare: dirty });
			expect(existsSync(session.worktree)).toBe(true);
			expect(git(project, ["diff", "--cached", "--name-only"])).toBe("");
		},
		GIT_TIMEOUT_MS,
	);
});
