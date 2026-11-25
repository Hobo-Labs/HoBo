/**
 * The `hobo-rift` command line.
 *
 * The entry point is a top-level script: importing it *is* running it. So each
 * case here sets `process.argv`, captures the two streams and the exit code,
 * and re-imports the module with a fresh registry. That is more machinery than
 * a normal unit test, and it is worth it, because the parts of this file that
 * can go wrong quietly are all in the argument handling rather than in the
 * workspace primitives underneath:
 *
 * - **The verb is found wherever it sits.** `hobo-rift --root /x create` and
 *   `hobo-rift create --root /x` are the same request. Treating `argv[0]` as
 *   the verb turned the first into a help screen that exited 0 — a caller
 *   scripting workspace creation would see success and no workspace.
 * - **Everything after `--` belongs to the inner command.** A `--name` in the
 *   tail is the caller's argument, not ours, and reading it as ours would run
 *   the command in the wrong workspace.
 * - **Failure has to be non-zero.** `remove` of a name that was never there,
 *   an unrecognised verb, and `exec` against an unregistered workspace each
 *   exit non-zero, because a caller that believes it cleaned up or ran
 *   something it did not is the failure mode with consequences.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MODULE = "../src/bin/hobo-rift.js";

class ExitSignal extends Error {
	constructor(readonly code: number) {
		super(`process.exit(${code})`);
	}
}

interface RunResult {
	stdout: string;
	stderr: string;
	/** `process.exit(n)` if it was called, otherwise the final `process.exitCode`. */
	exitCode: number;
}

let roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "hobo-rift-cli-"));
	roots.push(root);
	return root;
}

/**
 * Import the entry point with a given argv, capturing both streams.
 *
 * `process.exit` is stubbed to throw rather than to end the run, so a branch
 * that exits early is observable instead of taking the test runner with it.
 */
async function run(argv: readonly string[]): Promise<RunResult> {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const savedArgv = process.argv;
	const savedExitCode = process.exitCode;

	process.argv = ["node", "hobo-rift", ...argv];
	process.exitCode = undefined;

	const outSpy = vi
		.spyOn(process.stdout, "write")
		.mockImplementation((chunk: unknown) => {
			stdout.push(String(chunk));
			return true;
		});
	const errSpy = vi
		.spyOn(process.stderr, "write")
		.mockImplementation((chunk: unknown) => {
			stderr.push(String(chunk));
			return true;
		});
	const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
		code?: number,
	) => {
		throw new ExitSignal(code ?? 0);
	}) as never);

	let exitCode = 0;
	try {
		vi.resetModules();
		await import(MODULE);
		exitCode = process.exitCode === undefined ? 0 : Number(process.exitCode);
	} catch (error) {
		if (!(error instanceof ExitSignal)) throw error;
		exitCode = error.code;
	} finally {
		outSpy.mockRestore();
		errSpy.mockRestore();
		exitSpy.mockRestore();
		process.argv = savedArgv;
		process.exitCode = savedExitCode;
	}

	return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode };
}

beforeEach(() => {
	roots = [];
});

afterEach(async () => {
	for (const root of roots) {
		await rm(root, { recursive: true, force: true });
	}
	roots = [];
	vi.restoreAllMocks();
});

describe("verb resolution", () => {
	it("finds the verb after a value-taking flag", async () => {
		// The regression this exists for. `--root DIR init` puts the verb third;
		// reading `argv[0]` would treat `--root` as the verb, fall through to the
		// help branch, and exit 0 — a script would report success having done
		// nothing.
		const root = await makeRoot();
		const result = await run(["--root", root, "init"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("initialized");
	});

	it("finds the verb before the flags too", async () => {
		const root = await makeRoot();
		const result = await run(["init", "--root", root]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("initialized");
	});

	it("skips only the flags that actually take a value", async () => {
		// `--json` takes no value, so the token after it is still a candidate
		// verb. Skipping unconditionally after every flag would make
		// `--json capability` resolve to help.
		const root = await makeRoot();
		const result = await run(["--json", "capability", "--root", root]);
		expect(result.exitCode).toBe(0);
		expect(() => JSON.parse(result.stdout)).not.toThrow();
	});

	it("defaults to help with exit 0 when no verb is present", async () => {
		// Explicitly asking for nothing is a success; the help text is the
		// answer. Only an *unrecognised* verb is an error.
		const result = await run([]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("hobo-rift — virtual worktrees");
	});

	it("exits 2 for an unrecognised verb while still printing help", async () => {
		// Non-zero so a script notices, but the help still prints, because the
		// most likely cause is a typo and the fix is on screen.
		const result = await run(["frobnicate"]);
		expect(result.exitCode).toBe(2);
		expect(result.stdout).toContain("hobo-rift — virtual worktrees");
	});

	it("exits 0 for an explicit help request", async () => {
		const result = await run(["help"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("hobo-rift — virtual worktrees");
	});

	it("lists every verb in the help text", async () => {
		// The help is the only discovery surface. A verb that stopped being
		// listed would still work and nobody would know it existed.
		const result = await run(["help"]);
		for (const listed of [
			"capability",
			"init",
			"create",
			"list",
			"remove",
			"exec",
			"repair",
			"prune",
		]) {
			expect(result.stdout).toContain(listed);
		}
	});
});

describe("capability", () => {
	it("reports a tier and a reason in human form", async () => {
		const root = await makeRoot();
		const result = await run(["capability", "--root", root]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toMatch(/\S+ · \S/u);
	});

	it("emits a parseable record under --json, including the contract", async () => {
		// The contract is measured here rather than asserted inside the
		// capability record, so a consumer reading the JSON gets the same answer
		// the human line was derived from.
		const root = await makeRoot();
		const result = await run(["capability", "--root", root, "--json"]);
		const parsed = JSON.parse(result.stdout) as {
			tier: string;
			reason: string;
			isolatesInPlaceWrites: boolean;
			contract: unknown;
		};
		expect(typeof parsed.tier).toBe("string");
		expect(typeof parsed.reason).toBe("string");
		expect(typeof parsed.isolatesInPlaceWrites).toBe("boolean");
		expect(parsed.contract).toBeDefined();
	});

	it("warns in the human line when in-place writes reach the source", async () => {
		// The warning is the whole safety story for the weakest tier: on a
		// filesystem with no copy-on-write, an agent editing a file in the
		// workspace edits the original. Silence there would be the most
		// expensive possible omission.
		const root = await makeRoot();
		const human = await run(["capability", "--root", root]);
		const json = JSON.parse(
			(await run(["capability", "--root", root, "--json"])).stdout,
		) as { isolatesInPlaceWrites: boolean };
		if (json.isolatesInPlaceWrites) {
			expect(human.stdout).not.toContain("WARNING");
		} else {
			expect(human.stdout).toContain(
				"WARNING: in-place writes reach the source",
			);
		}
	});
});

describe("init", () => {
	it("reports initialized the first time and already registered after", async () => {
		// Idempotent, and says which happened. A second `init` that reported a
		// fresh initialization would hide that a root was already in use.
		const root = await makeRoot();
		expect((await run(["init", "--root", root])).stdout).toContain(
			"initialized",
		);
		const second = await run(["init", "--root", root]);
		expect(second.stdout).toContain("already registered");
		expect(second.exitCode).toBe(0);
	});

	it("emits the result record under --json", async () => {
		const root = await makeRoot();
		const result = await run(["init", "--root", root, "--json"]);
		const parsed = JSON.parse(result.stdout) as {
			created: boolean;
			root: string;
		};
		expect(parsed.created).toBe(true);
		expect(parsed.root).toBe(root);
	});
});

describe("create", () => {
	it("prints exactly the workspace path on stdout", async () => {
		// Matching upstream rift, so a caller can capture the path directly with
		// `$(hobo-rift create --name x)`. Any extra line on stdout would end up
		// inside that variable.
		const root = await makeRoot();
		await run(["init", "--root", root]);
		const result = await run(["create", "--root", root, "--name", "ws-a"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim().split("\n")).toHaveLength(1);
		expect(result.stdout.trim()).toContain("ws-a");
	});

	it("emits the whole workspace record under --json", async () => {
		const root = await makeRoot();
		await run(["init", "--root", root]);
		const result = await run([
			"create",
			"--root",
			root,
			"--name",
			"ws-a",
			"--json",
		]);
		const parsed = JSON.parse(result.stdout) as {
			name: string;
			path: string;
			tier: string;
		};
		expect(parsed.name).toBe("ws-a");
		expect(parsed.path).toContain("ws-a");
	});

	it("generates a name when none is given", async () => {
		// `ws-<timestamp>`. Refusing instead would make the common interactive
		// case need a name nobody cares about.
		const root = await makeRoot();
		await run(["init", "--root", root]);
		const result = await run(["create", "--root", root]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toMatch(/ws-\d+/u);
	});

	it("exits 1 with the reason on stderr when creation fails", async () => {
		// Creating twice under the same name is the reachable failure. The
		// reason goes to stderr so stdout stays exactly the path on success.
		const root = await makeRoot();
		await run(["init", "--root", root]);
		await run(["create", "--root", root, "--name", "ws-a"]);
		const result = await run(["create", "--root", root, "--name", "ws-a"]);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr.length).toBeGreaterThan(0);
	});
});

describe("list", () => {
	it("reports nothing for an empty root", async () => {
		const root = await makeRoot();
		await run(["init", "--root", root]);
		const result = await run(["list", "--root", root]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("");
	});

	it("prints one tab-separated line per workspace", async () => {
		// Tab-separated so `cut` and `awk` work on it; a workspace path can
		// contain spaces, which is exactly why the separator is not a space.
		const root = await makeRoot();
		await run(["init", "--root", root]);
		await run(["create", "--root", root, "--name", "ws-a"]);
		await run(["create", "--root", root, "--name", "ws-b"]);
		const result = await run(["list", "--root", root]);
		const lines = result.stdout.trim().split("\n");
		expect(lines).toHaveLength(2);
		for (const line of lines) {
			expect(line.split("\t")).toHaveLength(3);
		}
	});

	it("carries the registry and the parked directories under --json", async () => {
		const root = await makeRoot();
		await run(["init", "--root", root]);
		await run(["create", "--root", root, "--name", "ws-a"]);
		const result = await run(["list", "--root", root, "--json"]);
		const parsed = JSON.parse(result.stdout) as {
			workspaces: Array<{ name: string }>;
			debris: string[];
		};
		expect(parsed.workspaces.map((w) => w.name)).toEqual(["ws-a"]);
		// `debris` is always present, so a consumer never has to distinguish
		// "no parked directories" from "this version does not report them".
		expect(parsed.debris).toEqual([]);
	});
});

describe("prune", () => {
	it("says so when there is nothing parked", async () => {
		// A quiet no-op would leave an operator unsure whether prune ran.
		const root = await makeRoot();
		await run(["init", "--root", root]);
		const result = await run(["prune", "--root", root]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("no parked directories");
	});

	it("emits the removed list under --json", async () => {
		const root = await makeRoot();
		await run(["init", "--root", root]);
		const result = await run(["prune", "--root", root, "--json"]);
		expect(
			(JSON.parse(result.stdout) as { removed: string[] }).removed,
		).toEqual([]);
	});
});

describe("repair", () => {
	it("rebuilds the registry and reports the count", async () => {
		// Repair exists for a torn write; the count is how an operator confirms
		// the rebuild found what they expected rather than silently emptying it.
		const root = await makeRoot();
		await run(["init", "--root", root]);
		await run(["create", "--root", root, "--name", "ws-a"]);
		const result = await run(["repair", "--root", root]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("registry now lists 1 workspace(s)");
	});

	it("emits the rebuilt registry under --json", async () => {
		const root = await makeRoot();
		await run(["init", "--root", root]);
		const result = await run(["repair", "--root", root, "--json"]);
		expect(
			(JSON.parse(result.stdout) as { workspaces: unknown[] }).workspaces,
		).toEqual([]);
	});
});

describe("remove", () => {
	it("exits 2 with a message when --name is missing", async () => {
		// Exit 2 for a usage error, distinct from the exit 1 that means "the
		// thing you named was not there".
		const result = await run(["remove", "--root", await makeRoot()]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("remove needs --name");
	});

	it("removes an existing workspace and exits 0", async () => {
		const root = await makeRoot();
		await run(["init", "--root", root]);
		await run(["create", "--root", root, "--name", "ws-a"]);
		const result = await run(["remove", "--root", root, "--name", "ws-a"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("removed ws-a");
		expect((await run(["list", "--root", root])).stdout.trim()).toBe("");
	});

	it("exits 1 for a workspace that was never there", async () => {
		// The consequential case: reporting success for a workspace that did not
		// exist would let a caller believe it had cleaned up something it had
		// not, and move on to reusing the name or the disk.
		const root = await makeRoot();
		await run(["init", "--root", root]);
		const result = await run(["remove", "--root", root, "--name", "ghost"]);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("no workspace named ghost");
	});

	it("reports removed:false under --json rather than an empty document", async () => {
		const root = await makeRoot();
		await run(["init", "--root", root]);
		const result = await run([
			"remove",
			"--root",
			root,
			"--name",
			"ghost",
			"--json",
		]);
		const parsed = JSON.parse(result.stdout) as {
			removed: boolean;
			name: string;
		};
		expect(parsed.removed).toBe(false);
		expect(parsed.name).toBe("ghost");
		expect(result.exitCode).toBe(1);
	});
});

describe("exec", () => {
	it("exits 2 when neither -- nor --shell was given", async () => {
		const root = await makeRoot();
		await run(["init", "--root", root]);
		await run(["create", "--root", root, "--name", "ws-a"]);
		const result = await run(["exec", "--root", root, "--name", "ws-a"]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("exec needs --name");
	});

	it("exits 2 when --name is missing", async () => {
		const root = await makeRoot();
		const result = await run(["exec", "--root", root, "--", "true"]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("exec needs --name");
	});

	it("exits 2 for an empty argv vector after --", async () => {
		const root = await makeRoot();
		await run(["init", "--root", root]);
		await run(["create", "--root", root, "--name", "ws-a"]);
		const result = await run(["exec", "--root", root, "--name", "ws-a", "--"]);
		expect(result.exitCode).toBe(2);
	});

	it("exits 1 rather than falling back to the source for an unknown workspace", async () => {
		// The most dangerous branch in the file. Falling back would run an
		// agent's command against the very tree the workspace exists to protect,
		// and the command would appear to succeed.
		const root = await makeRoot();
		await run(["init", "--root", root]);
		const result = await run([
			"exec",
			"--root",
			root,
			"--name",
			"ghost",
			"--",
			"true",
		]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("no workspace named ghost");
	});

	it("quotes each element of the argv vector under --print-cmd", async () => {
		// The bug the vector form exists to fix: the caller's shell has already
		// consumed their quoting, so joining with spaces let a path containing a
		// space split into stray positionals. Each element is re-quoted.
		const root = await makeRoot();
		await run(["init", "--root", root]);
		await run(["create", "--root", root, "--name", "ws-a"]);
		const result = await run([
			"exec",
			"--root",
			root,
			"--name",
			"ws-a",
			"--print-cmd",
			"--",
			"echo",
			"two words",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("two words");
		// Quoted as one argument, not two bare tokens.
		expect(result.stdout).toMatch(/'two words'|"two words"/u);
	});

	it("neutralises shell metacharacters in the vector", async () => {
		// A workspace path or argument containing `;` or `$(…)` must not execute
		// in the namespace before the workspace command runs. This is the
		// injection case, and the quoting is the whole defence.
		const root = await makeRoot();
		await run(["init", "--root", root]);
		await run(["create", "--root", root, "--name", "ws-a"]);
		const result = await run([
			"exec",
			"--root",
			root,
			"--name",
			"ws-a",
			"--print-cmd",
			"--",
			"echo",
			"; rm -rf /",
		]);
		expect(result.exitCode).toBe(0);
		// The dangerous text is present as data, inside quotes, rather than as a
		// bare command separator.
		expect(result.stdout).toMatch(/'; rm -rf \/'|"; rm -rf \/"/u);
	});

	it("passes a --shell snippet through unquoted", () => {
		// The explicit opt-in: `--shell` is how a caller asks for shell syntax,
		// so it is deliberately *not* quoted. Having both forms is what lets the
		// vector form stay strict.
		return makeRoot().then(async (root) => {
			await run(["init", "--root", root]);
			await run(["create", "--root", root, "--name", "ws-a"]);
			const result = await run([
				"exec",
				"--root",
				root,
				"--name",
				"ws-a",
				"--print-cmd",
				"--shell",
				"echo a && echo b",
			]);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("echo a && echo b");
		});
	});

	it("treats a --name after -- as the inner command's argument", async () => {
		// Everything after `--` belongs to the command being run. Reading a
		// `--name` from the tail as ours would execute in the wrong workspace —
		// silently, since both names are plausible.
		const root = await makeRoot();
		await run(["init", "--root", root]);
		await run(["create", "--root", root, "--name", "ws-a"]);
		const result = await run([
			"exec",
			"--root",
			root,
			"--name",
			"ws-a",
			"--print-cmd",
			"--",
			"some-tool",
			"--name",
			"inner",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("inner");
		expect(result.stdout).toContain("ws-a");
	});
});
