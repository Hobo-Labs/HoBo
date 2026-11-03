/**
 * The Git pane's remaining verbs: the ones that reach for a remote, the ones
 * that need an approval digest, and the ones that only move focus.
 *
 * `git-terminal-pane-driver.test.ts` covers opening the pane, moving around,
 * staging, and the yes/no gate in front of discard. This file covers what is
 * left of the key dispatch, which is where the pane's two most consequential
 * shapes live.
 *
 * **An approval digest is not a yes/no question.** Commit, push, open-PR, stack
 * and merge do not ask "are you sure" — they print the exact effect and a
 * digest, and require that digest typed back. That is a deliberately different
 * gate from the local one: a discard destroys a file the operator can see,
 * while these five push work out of the machine, where nobody can take it back.
 * A prompt an operator can clear by holding `y` would not be a gate at all. The
 * tests assert that a *wrong* digest leaves nothing done, because a gate that
 * accepts anything typed is decoration.
 *
 * **A failing verb reports and stays open.** Against a repository with no
 * remote and no forge CLI, `pull`, stack and merge all fail — and the pane's
 * answer is a message in its own status line, not an exit. A pane that closed
 * on the first failure would drop the operator back to a shell with no
 * explanation of what went wrong. The message has to name the cause: "merge
 * failed" teaches nothing, while "gh pr failed: spawn gh ENOENT" tells the
 * operator what to install.
 *
 * Two of those failures happen *before* an approval is minted, so the stack and
 * merge cases here assert the failure rather than the approval text. Asserting
 * the approval would be asserting a string this environment cannot produce.
 * `fetch`, meanwhile, succeeds: `git fetch --prune` with no remote exits 0,
 * because there is nothing to fetch and that is not an error.
 *
 * As in the sibling file, a real `git` and a real worktree are used: a faked git
 * would let the pane and the fake agree with each other while both are wrong.
 * Every run ends in a quit key and a deadline, because the loop reads until `q`
 * and a forgotten quit would hang the suite rather than fail it.
 */
import { execFileSync } from "node:child_process";
import {
	cpSync,
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

/**
 * Every test here drives real `git` subprocesses through a real worktree, and
 * runs alongside the rest of the package. Vitest's 10s default is shorter than
 * that takes on a loaded machine, and a tighter deadline would produce a suite
 * that is green alone and red in CI — which reads as a product bug nobody can
 * reproduce.
 */
const GIT_TIMEOUT_MS = 90_000;

const temps: string[] = [];

afterEach(() => {
	for (const dir of temps.splice(0))
		rmSync(dir, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 50,
		});
});

function temp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temps.push(dir);
	return dir;
}

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	});
}

/**
 * A repository with one commit, no remote, and nothing outstanding.
 *
 * No remote is deliberate: the remote-facing verbs have to resolve somewhere,
 * and a repository with no origin resolves locally and instantly rather than
 * reaching a network the test suite has no business touching. `pull` fails
 * there for want of an upstream; `fetch` succeeds, having nothing to do.
 */
function repository(): string {
	const root = temp("hobo-git-actions-repo-");
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
	template = mkdtempSync(join(tmpdir(), "hobo-git-actions-template-"));
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

/** A worktree with something already stashed, so the stash panel is not empty. */
function stashed(worktree: string): void {
	dirty(worktree);
	git(worktree, ["stash", "push", "-u", "-m", "parked"]);
}

/**
 * A tmux that answers plausibly without one being installed. The pane never
 * drives tmux, but the session control it loads through does, and a missing
 * binary would fail the setup rather than the behaviour under test.
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
	return Object.assign(stream, {
		isTTY: true as const,
		isRaw: false,
		rawModeCalls,
		setRawMode(mode: boolean) {
			rawModeCalls.push(mode);
			return stream;
		},
	});
}

function fakeStdout(columns = 100, rows = 30) {
	const chunks: string[] = [];
	let writes = 0;
	const waiters: { readonly after: number; readonly resolve: () => void }[] =
		[];
	const stream = new Writable({
		write(chunk, _encoding, done) {
			chunks.push(String(chunk));
			writes += 1;
			for (const waiter of waiters.splice(0)) {
				if (writes > waiter.after) waiter.resolve();
				else waiters.push(waiter);
			}
			done();
		},
	});
	return Object.assign(stream, {
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
	});
}

const QUIT = "q";

/**
 * Escape, which cancels a prompt.
 *
 * Written as a real escape byte rather than an empty string. An empty write to
 * the stdin stream emits no `data` event at all, so the pane would never see
 * the key and the feed would sit out its whole settle deadline instead — a test
 * that takes twenty seconds to prove nothing.
 */
const ESC = "";

/**
 * Open the pane on a session whose worktree is `repo`, feed `keys`, and return
 * what happened.
 *
 * Keys are fed one at a time, each waiting for the pane to answer the last. The
 * loop guards itself with a `busy` flag and *drops* a key that arrives
 * mid-action, so a fixed-interval feed silently loses keys whenever a git
 * subprocess runs slower than the guess — under coverage instrumentation, most
 * of them.
 */
async function pane(
	repo: string,
	keys: readonly string[],
	options: {
		/** Runs against the session's worktree before the pane opens. */
		readonly prepare?: (worktree: string) => void;
	} = {},
) {
	const hoboHome = temp("hobo-git-actions-home-");
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
	// Read the worktree back rather than reconstructing it: the path carries a
	// hash the session derives, and a hand-built path would start asserting
	// against an empty directory the moment that derivation changed.
	const worktree = created?.session?.worktreePath;
	if (typeof worktree !== "string" || worktree.length === 0)
		throw new Error("the session reported no worktree path");

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
		// Then keep asking to leave until the pane actually leaves — a single
		// quit can land in the busy gap and vanish, and a pane that never quits
		// hangs the test rather than failing it.
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

describe("focusing a panel", () => {
	it.each([
		["1", "1 Status"],
		["3", "3 Branches"],
		["4", "4 Commits"],
		["5", "5 Stash"],
	])(
		"moves focus to %s",
		async (key, title) => {
			// The active panel is marked in its own heading; without the marker the
			// operator has no way to tell which list the arrow keys move.
			const session = await pane(repository(), [key, QUIT]);
			expect(session.output).toContain(`▸ ${title}`);
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"ignores a key that is not a verb",
		async () => {
			// An unrecognised key repaints and does nothing. A pane that treated
			// unknown input as an error would fill its status line with noise the
			// first time someone leaned on the keyboard.
			const session = await pane(repository(), ["Z", QUIT]);
			expect(session.code).toBe(0);
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"lists the keys that are not on the footer",
		async () => {
			// The footer has room for the common verbs; `?` is where the rest live,
			// and a verb documented nowhere is a verb nobody uses.
			const session = await pane(repository(), ["?", QUIT]);
			expect(session.output).toMatch(/n branch · i ignore · x discard/u);
		},
		GIT_TIMEOUT_MS,
	);
});

describe("verbs that reach for a remote", () => {
	it.each([
		["fetch", "f"],
		["pull", "P"],
	])(
		"stays open after %s",
		async (_label, key) => {
			// The pane's answer to a failed verb is a status line, not an exit.
			// Closing on the first failure would drop the operator back to a shell
			// with no explanation of what went wrong.
			const session = await pane(repository(), [key, QUIT]);
			expect(session.code).toBe(0);
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"treats a fetch with no remote as nothing to do",
		async () => {
			// `git fetch --prune` with no remote configured exits 0 — there is
			// nothing to fetch, which is not an error. Recorded because it reads
			// like it ought to fail, and a test written on that assumption passes
			// for the wrong reason on the *pull* case next door.
			const session = await pane(repository(), ["f", QUIT]);
			expect(session.output).not.toMatch(/fetch failed/u);
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"says why a pull with no upstream failed",
		async () => {
			// Pull does fail here, and the reason git gives is the useful half:
			// "git pull failed" alone would leave the operator guessing between no
			// remote, no upstream, and a rejected fast-forward.
			const session = await pane(repository(), ["P", QUIT]);
			expect(session.output).toMatch(/no tracking information/u);
		},
		GIT_TIMEOUT_MS,
	);
});

/**
 * Ignoring is asserted through `git status`, not by reading a file.
 *
 * The pane does not write `.gitignore`. It appends to whatever
 * `git rev-parse --git-path info/exclude` resolves to — which, in a linked
 * worktree, is inside the *main* repository's `.git/worktrees/<name>/`, not
 * anywhere under the worktree itself. That is the right choice (an ignore made
 * from a session pane is that session's business, not a change to a tracked
 * file every branch shares), and it means a test that read `.gitignore` would
 * report "not ignored" no matter what the pane did. Asking git is the only
 * assertion that survives where the exclude file lives.
 */
const untrackedIsListed = (worktree: string): boolean =>
	git(worktree, ["status", "--porcelain"]).includes("untracked.txt");

describe("ignoring a file", () => {
	// `j` first: the files panel lists `tracked.txt` before `untracked.txt`, and
	// only an untracked file can be ignored (below).

	it(
		"hides the file from status when the answer is yes",
		async () => {
			const session = await pane(repository(), ["2", "j", "i", "yes\r", QUIT], {
				prepare: dirty,
			});
			expect(untrackedIsListed(session.worktree)).toBe(false);
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"leaves the file listed when the answer is no",
		async () => {
			// Ignoring hides a file from every later status; an operator who said no
			// must not find it gone from the list anyway.
			const session = await pane(repository(), ["2", "j", "i", "no\r", QUIT], {
				prepare: dirty,
			});
			expect(untrackedIsListed(session.worktree)).toBe(true);
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"names the file in the question",
		async () => {
			const session = await pane(repository(), ["2", "j", "i", "no\r", QUIT], {
				prepare: dirty,
			});
			expect(session.output).toMatch(/ignore untracked\.txt/u);
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"refuses to ignore a tracked file",
		async () => {
			// Ignoring a tracked file does not untrack it — git keeps reporting the
			// modification while the operator believes it is hidden. Refusing is the
			// honest answer to a request that cannot mean what it looks like.
			const session = await pane(repository(), ["2", "i", "yes\r", QUIT], {
				prepare: dirty,
			});
			expect(session.output).toMatch(/only untracked files can be ignored/u);
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"does nothing outside the files panel",
		async () => {
			// There is no file selected on the branches panel, and guessing one
			// would ignore a path the operator never pointed at.
			const session = await pane(repository(), ["3", "i", QUIT]);
			expect(session.output).not.toMatch(/ignore /u);
		},
		GIT_TIMEOUT_MS,
	);
});

describe("the stash panel", () => {
	it(
		"applies the selected stash",
		async () => {
			// Apply restores the edit and keeps the entry.
			const session = await pane(repository(), ["5", "a", QUIT], {
				prepare: stashed,
			});
			expect(readFileSync(join(session.worktree, "tracked.txt"), "utf8")).toBe(
				"edited\n",
			);
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"asks before popping",
		async () => {
			// Pop removes the entry as well as restoring it: if the restore
			// conflicts, the parked work has nowhere left to be.
			const session = await pane(repository(), ["5", "O", "no\r", QUIT], {
				prepare: stashed,
			});
			expect(session.output).toMatch(/pop stash@\{0\} — type yes to approve/u);
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"keeps the stash when the pop is refused",
		async () => {
			const session = await pane(repository(), ["5", "O", "no\r", QUIT], {
				prepare: stashed,
			});
			expect(git(session.worktree, ["stash", "list"])).toContain("parked");
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"drops the selected stash when the answer is yes",
		async () => {
			const session = await pane(repository(), ["5", "x", "yes\r", QUIT], {
				prepare: stashed,
			});
			expect(git(session.worktree, ["stash", "list"])).toBe("");
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"keeps the stash when the drop is refused",
		async () => {
			const session = await pane(repository(), ["5", "x", "no\r", QUIT], {
				prepare: stashed,
			});
			expect(git(session.worktree, ["stash", "list"])).toContain("parked");
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"does nothing on apply with an empty stash list",
		async () => {
			// Nothing is selected, so there is nothing to apply — and no message,
			// because the operator asked for a no-op and got one.
			const session = await pane(repository(), ["5", "a", QUIT]);
			expect(session.code).toBe(0);
		},
		GIT_TIMEOUT_MS,
	);
});

describe("the approval digest in front of anything that leaves the machine", () => {
	// These five do not ask "are you sure". They print the exact effect and a
	// digest, and require the digest typed back. The gate exists because the
	// effect is outside the machine, where nobody can take it back.

	it(
		"prints the exact effect before a commit",
		async () => {
			const session = await pane(
				repository(),
				["c", "a message\r", ESC, QUIT],
				{
					prepare: dirty,
				},
			);
			expect(session.output).toContain("Exact effect:");
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"quotes the commit message in the effect it describes",
		async () => {
			// The approval has to name what is being approved; "commit" alone is not
			// something an operator can check.
			const session = await pane(
				repository(),
				["c", "a message\r", ESC, QUIT],
				{
					prepare: dirty,
				},
			);
			expect(session.output).toContain('commit staged changes as "a message"');
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"asks for the digest to be typed back",
		async () => {
			const session = await pane(
				repository(),
				["c", "a message\r", ESC, QUIT],
				{
					prepare: dirty,
				},
			);
			expect(session.output).toContain("Type the approval digest to continue");
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"commits nothing when the digest is wrong",
		async () => {
			// A gate that accepts anything typed is decoration. The assertion is on
			// the log, not the output: a pane that printed "cancelled" after
			// committing would pass a test that only read what it said.
			const session = await pane(
				repository(),
				["c", "a message\r", "not-the-digest\r", QUIT],
				{ prepare: dirty },
			);
			expect(git(session.worktree, ["log", "--oneline"])).not.toContain(
				"a message",
			);
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"commits nothing when the message is left empty",
		async () => {
			// An empty answer is a cancel, not a commit with no subject.
			const session = await pane(repository(), ["c", "\r", QUIT], {
				prepare: dirty,
			});
			expect(session.output).not.toContain("Exact effect:");
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"describes a push without asking for anything to be typed first",
		async () => {
			// Push has nothing to collect: the branch and the remote are already
			// decided, so the digest is the whole of the interaction.
			const session = await pane(repository(), ["p", ESC, QUIT]);
			expect(session.output).toContain("push current branch to origin");
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"asks for a pull request title before describing one",
		async () => {
			const session = await pane(repository(), ["o", ESC, QUIT]);
			expect(session.output).toContain("Pull request title");
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"opens no pull request when the title is left empty",
		async () => {
			const session = await pane(repository(), ["o", "\r", QUIT]);
			expect(session.output).not.toContain("open pull request");
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"asks for the parent branch and the title before stacking",
		async () => {
			// Both answers are collected before anything is attempted: a stacked PR
			// is meaningless without the branch it stacks onto.
			const session = await pane(repository(), [
				"S",
				"main\r",
				"on top\r",
				ESC,
				QUIT,
			]);
			expect(session.output).toContain("Parent branch");
			expect(session.output).toContain("Pull request title");
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"reports the forge failure rather than an approval it never minted",
		async () => {
			// Stacking reads the pre-effect pull request state first, and against a
			// repository with no forge that read fails — so no approval is ever
			// created. The pane reports that and stays open. Asserting the approval
			// text here would be asserting a string this environment cannot produce.
			const session = await pane(repository(), [
				"S",
				"main\r",
				"on top\r",
				QUIT,
			]);
			expect(session.output).toMatch(
				/cannot establish pre-effect pull request state/u,
			);
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"stops asking when the parent branch is left empty",
		async () => {
			// No parent means no stack, and asking for a title afterwards would be
			// collecting an answer it has already decided to throw away.
			const session = await pane(repository(), ["S", "\r", QUIT]);
			expect(session.output).not.toContain("Pull request title");
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"asks for the pull request number before merging",
		async () => {
			const session = await pane(repository(), ["M", "42\r", ESC, QUIT]);
			expect(session.output).toContain("Pull request number");
		},
		GIT_TIMEOUT_MS,
	);

	it(
		"reports a missing forge CLI rather than an approval it never minted",
		async () => {
			// Merge shells out to `gh`, which is absent here, so the command fails
			// before any approval exists. The failure names the tool — an operator
			// who reads "merge failed" learns nothing they can act on, while
			// "spawn gh ENOENT" tells them what to install.
			const session = await pane(repository(), ["M", "42\r", QUIT]);
			expect(session.output).toMatch(/gh pr failed/u);
		},
		GIT_TIMEOUT_MS,
	);

	it.each([
		["a word", "not-a-number\r"],
		["zero", "0\r"],
		["a negative", "-3\r"],
		["a fraction", "1.5\r"],
	])(
		"merges nothing when the number is %s",
		async (_label, answer) => {
			// `Number("")` is 0 and `Number("x")` is NaN; neither is a pull request,
			// and a merge aimed at #0 is a merge aimed at whatever the forge decides
			// that means.
			const session = await pane(repository(), ["M", answer, QUIT]);
			expect(session.output).not.toContain("squash merge pull request");
		},
		GIT_TIMEOUT_MS,
	);
});
