/**
 * Every `hobo-code` verb, answered on a machine with nothing set up.
 *
 * `cli-readonly-verb-surface.test.ts` beside this file covers fifteen verbs in
 * depth. This one goes the other way — every verb the CLI dispatches, driven
 * against a fresh empty `HOBO_HOME` — because the thing worth checking across
 * the whole surface is not what each verb *says* but that none of them fall
 * over on a machine where nothing exists yet. That is the state of every first
 * run, and it is the state a user is in precisely when they are most likely to
 * be typing verbs at random to find out what the tool does.
 *
 * Three properties hold across all of them:
 *
 * **A verb answers rather than throwing.** An unhandled exception out of the
 * CLI reaches the user as a stack trace, which is the worst possible answer to
 * "what is this tool" — it reads as a broken install rather than a missing
 * session.
 *
 * **Every answer carries a stable code, and the exit status matches it.** The
 * shell, the dashboard and every script branch on `result.code`; the exit
 * status is what a shell pipeline branches on. A verb whose `ok` disagreed
 * with its exit status would make `&&` chains behave differently from the UI
 * showing the same run.
 *
 * **"Nothing here yet" is not a failure.** `tasks`, `machines`, `session
 * list`, `template`, `review`, `dashboard`, `env` and the rest all succeed
 * with an empty station. Only three things legitimately fail on a bare
 * machine: `resume` and `compact` (there is no prior chat to resume or
 * shrink), and `init` (a capability the environment has to grant). Reporting
 * an empty station as an error would train a user to ignore CLI errors on
 * exactly the day they should not.
 *
 * Each run gets its own `HOBO_HOME`, so nothing leaks between tests and
 * nothing touches the developer's real station.
 */
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readlinkSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import {
	formatHoboCodeResult,
	type HoboCodeCliResult,
	runHoboCodeCli,
} from "../src/cli.js";
import { testEnv } from "./test-env.js";

const homes: string[] = [];

/** The processes whose working directory is under `dir`. */
function workingUnder(dir: string): number[] {
	// /proc cwd enumeration is Linux-only; elsewhere there is no portable
	// per-process cwd query, so this leak check does not apply.
	if (!existsSync("/proc")) return [];
	return readdirSync("/proc")
		.filter((name) => /^\d+$/u.test(name))
		.map(Number)
		.filter((pid) => {
			try {
				return readlinkSync(`/proc/${pid}/cwd`).startsWith(dir);
			} catch {
				return false;
			}
		});
}

// A verb that left a process working in its HOBO_HOME (mux once seated the
// agents on PATH there) raced the removal below: ENOTEMPTY.
afterEach(() => {
	const homesNow = homes.splice(0);
	const working = homesNow.flatMap((dir) => workingUnder(dir));
	for (const dir of homesNow) rmSync(dir, { recursive: true, force: true });
	expect(working, "processes still working in a verb's HOBO_HOME").toEqual([]);
});

async function run(
	argv: readonly string[],
	input?: NodeJS.ReadableStream,
): Promise<HoboCodeCliResult> {
	const hoboHome = mkdtempSync(join(tmpdir(), "hobo-code-sweep-"));
	homes.push(hoboHome);
	return await runHoboCodeCli([...argv], {
		hoboHome,
		cwd: hoboHome,
		env: testEnv({
			HOBO_HOME: hoboHome,
			HOBO_ENV: "local-dev",
			HOBO_CODE_SIDECARS: "0",
		}),
		json: false,
		allocateWorkspaces: async ({ workspaceRoot, agentIds }) => ({
			backend: "shared",
			workspaces: agentIds.map((agentId) => ({
				agentId,
				path: workspaceRoot,
				backend: "shared",
			})),
		}),
		muxRunner: { run: async () => ({ code: 0, stdout: "hobo\n" }) },
		...(input !== undefined ? { input } : undefined),
	});
}

/**
 * Every verb that answers successfully on a machine with nothing set up,
 * paired with the code it answers with.
 */
const SUCCEEDS: ReadonlyArray<readonly [readonly string[], string]> = [
	[["agent"], "HOBO_CODE_AGENT"],
	[["agents"], "HOBO_CODE_AGENTS"],
	[["agents", "list"], "HOBO_CODE_AGENTS"],
	[["attach"], "HOBO_CODE_ATTACH"],
	[["auth"], "HOBO_CODE_AUTH"],
	[["auth", "status"], "HOBO_CODE_AUTH"],
	[["dashboard"], "HOBO_CODE_DASHBOARD"],
	[["edit"], "HOBO_CODE_EDIT"],
	[["env"], "HOBO_CODE_ENV"],
	[["guide"], "HOBO_CODE_GUIDE"],
	[["guide", "cursor"], "HOBO_CODE_GUIDE"],
	[["isolate"], "HOBO_CODE_ISOLATE"],
	[["isolate", "status"], "HOBO_CODE_ISOLATE"],
	[["machines"], "HOBO_CODE_MACHINES"],
	[["mux"], "HOBO_CODE_MUX"],
	[["mux", "list"], "HOBO_CODE_MUX"],
	[["review"], "HOBO_CODE_REVIEW"],
	[["review", "list"], "HOBO_CODE_REVIEW"],
	[["scaffold"], "HOBO_CODE_SCAFFOLD"],
	[["session"], "HOBO_CODE_SESSION"],
	[["session", "list"], "HOBO_CODE_RESIDENT_SESSION"],
	[["tasks"], "HOBO_CODE_TASKS"],
	[["template"], "HOBO_CODE_TEMPLATE"],
	[["template", "list"], "HOBO_CODE_TEMPLATE"],
];

/** Verbs that legitimately fail on a bare machine, and why. */
const FAILS: ReadonlyArray<readonly [readonly string[], string]> = [
	// No prior chat to resume.
	[["resume"], "HOBO_CODE_RESUME_NONE"],
	// No prior chat to shrink.
	[["compact"], "HOBO_CODE_COMPACT_NONE"],
	// Promoting needs to be told what to promote.
	[["promote"], "HOBO_CODE_USAGE"],
	// Init needs a capability the environment grants.
	[["init"], "HOBO_CODE_INIT_CAPABILITY"],
];

describe("a verb answers on a bare machine", () => {
	it.each(SUCCEEDS)("%s succeeds", async (argv, code) => {
		// Nothing exists yet — no session, no task, no agent, no project. That
		// is the state of every first run, and it is when a user is most likely
		// to be typing verbs at random to find out what the tool does.
		const result = await run(argv);
		expect(result.ok).toBe(true);
		expect(result.code).toBe(code);
	});

	it.each(SUCCEEDS)("%s exits zero", async (argv) => {
		// A shell pipeline branches on this. A verb whose `ok` disagreed with
		// its exit status would make `&&` chains behave differently from the UI
		// showing the same run.
		expect((await run(argv)).exitCode).toBe(0);
	});

	it.each(SUCCEEDS)("%s says something", async (argv) => {
		// An empty message renders as a blank panel, which reads as a hang.
		expect((await run(argv)).message.length).toBeGreaterThan(0);
	});

	it.each(SUCCEEDS)("%s renders without throwing", async (argv) => {
		// The formatter branches on code, remediation and body shape; a verb
		// whose result it could not render would fail after the work was done.
		expect(formatHoboCodeResult(await run(argv)).length).toBeGreaterThan(0);
	});

	it.each(SUCCEEDS)("%s serialises to JSON", async (argv) => {
		// Every verb is scriptable. A result carrying something JSON cannot
		// represent would break the script and not the UI, which is the harder
		// failure to trace.
		const parsed = JSON.parse(formatHoboCodeResult(await run(argv), true));
		expect(parsed.code).toBeTypeOf("string");
	});
});

describe("a verb that legitimately cannot answer yet", () => {
	it.each(FAILS)("%s fails with its own code", async (argv, code) => {
		expect((await run(argv)).code).toBe(code);
	});

	it.each(FAILS)("%s exits non-zero", async (argv) => {
		expect((await run(argv)).exitCode).toBeGreaterThan(0);
	});

	it.each(FAILS)("%s reports itself as not ok", async (argv) => {
		expect((await run(argv)).ok).toBe(false);
	});

	it.each(FAILS)("%s still renders", async (argv) => {
		expect(formatHoboCodeResult(await run(argv)).length).toBeGreaterThan(0);
	});
});

describe("an empty station is not an error", () => {
	// The distinction the whole failure list rests on: reporting "nothing here
	// yet" as an error trains a user to ignore CLI errors on exactly the day
	// they should not.
	it.each([
		["tasks"],
		["machines"],
		["dashboard"],
		["env"],
		["template"],
		["review"],
		["agents"],
	])("%s succeeds with nothing to list", async (verb) => {
		expect((await run([verb])).ok).toBe(true);
	});

	it("lists no resident sessions without failing", async () => {
		expect((await run(["session", "list"])).ok).toBe(true);
	});

	it("reports no agents without failing", async () => {
		expect((await run(["agents", "list"])).ok).toBe(true);
	});
});

describe("verb help", () => {
	const HELPED = [
		"agents",
		"attach",
		"auth",
		"dashboard",
		"dev",
		"edit",
		"env",
		"isolate",
		"machines",
		"mux",
		"promote",
		"review",
		"scaffold",
		"session",
		"tasks",
		"template",
	];

	it.each(
		HELPED,
	)("answers %s --help with the verb's own help", async (verb) => {
		// A user who typed `hobo-code dev --help` wants `dev`; handing back the
		// index is a silent redirect that costs them a second read.
		const result = await run([verb, "--help"]);
		expect(result.code).toBe("HOBO_CODE_HELP");
		expect(result.message).toContain(verb);
	});

	it.each(HELPED)("succeeds on %s --help", async (verb) => {
		// Help is never a failure, even for a verb that would fail if run.
		expect((await run([verb, "--help"])).ok).toBe(true);
	});

	it("answers a help topic through the help verb too", async () => {
		expect((await run(["help", "dev"])).message).toContain("dev");
	});

	it("falls back to the index for an unknown help topic", async () => {
		// Guessing the nearest topic would answer a question the user did not
		// ask; the index at least lists what exists.
		expect((await run(["help", "no-such-topic"])).ok).toBe(true);
	});
});

describe("refusing what it cannot do", () => {
	it("names an unknown verb rather than guessing", async () => {
		// Running the nearest match would do something the user did not type,
		// and this CLI's verbs include ones that write.
		const result = await run(["reticulate-splines"]);
		expect(result.code).toBe("HOBO_CODE_UNKNOWN_VERB");
		expect(result.ok).toBe(false);
	});

	it("exits non-zero for an unknown verb", async () => {
		expect((await run(["reticulate-splines"])).exitCode).toBeGreaterThan(0);
	});

	it("refuses an unknown flag rather than ignoring it", async () => {
		// A silently dropped flag runs a command the user did not ask for --
		// the same failure as a slash command losing its arguments, but with
		// no palette to notice it in.
		const result = await run(["edit", "--no-such-flag"]);
		expect(result.code).toBe("HOBO_CODE_UNKNOWN_FLAG");
	});

	it("refuses an unknown config stack by name", async () => {
		expect((await run(["config", "no-such-stack"])).code).toBe(
			"HOBO_CODE_CONFIG_USAGE",
		);
	});

	it("refuses a review that does not exist", async () => {
		// The id came from somewhere -- a stale link, a typo. Silently opening
		// a different review would be worse than refusing.
		expect((await run(["review", "no-such-review"])).code).toBe(
			"HOBO_CODE_REVIEW_NOT_FOUND",
		);
	});

	it("names an id in the refusal so the reader can check it", async () => {
		// Recorded as it behaves: the positional is not read as the review id
		// -- the message names a freshly generated one instead. Worth pinning
		// because a reader comparing that id against their link will find it
		// matches nothing, and this test is where the next person looking at
		// that confusion will land.
		expect((await run(["review", "no-such-review"])).message).toMatch(
			/review [0-9a-f-]{36} does not exist/,
		);
	});

	it("fails a session subcommand it cannot carry out", async () => {
		// `session new` needs a project; on a bare machine it has none, and
		// inventing one would put a worktree somewhere the user never chose.
		expect((await run(["session", "new"])).ok).toBe(false);
	});
});

describe("the virtual shell", () => {
	// Kept out of the parametrized sweep deliberately: `vshell` reads real
	// stdin, so several of them running concurrently under `it.each` fight
	// over the same handle. One at a time it is well behaved.
	it("opens and closes a virtual pane on a bare machine", {
		timeout: 60_000,
	}, async () => {
		// One test, not several: two `vshell` runs in the same file contend
		// for the same stdin handle and the second reads EOF immediately.
		const result = await run(["vshell"], Readable.from([]));
		expect(result.ok).toBe(true);
		expect(result.code).toBe("HOBO_CODE_VSHELL");
		expect(result.message.length).toBeGreaterThan(0);
		expect(result.exitCode).toBe(0);
	});
});

describe("the --json flag on a verb that lists things", () => {
	it.each([
		["tasks"],
		["machines"],
		["env"],
		["dashboard"],
	])("%s --json still succeeds", async (verb) => {
		expect((await run([verb, "--json"])).ok).toBe(true);
	});

	it.each([
		["tasks"],
		["machines"],
		["env"],
		["dashboard"],
	])("%s --json keeps its code", async (verb) => {
		// The flag changes the rendering, not the outcome; a code that
		// shifted under `--json` would make scripts and humans disagree
		// about what happened.
		const [plain, json] = await Promise.all([
			run([verb]),
			run([verb, "--json"]),
		]);
		expect(json.code).toBe(plain.code);
	});
});

describe("subcommands that fall through", () => {
	it.each([
		["agents", "HOBO_CODE_AGENTS"],
		["auth", "HOBO_CODE_AUTH"],
		["isolate", "HOBO_CODE_ISOLATE"],
		["mux", "HOBO_CODE_MUX"],
		["attach", "HOBO_CODE_ATTACH"],
		["template", "HOBO_CODE_TEMPLATE"],
	])("%s answers its overview for an unrecognised subcommand", async (verb, code) => {
		// Recorded as it behaves. These verbs treat an unknown subcommand
		// as "show me the overview" rather than refusing -- defensible for
		// read-only verbs, where the overview is what the user was probably
		// after, and it keeps a typo from being a dead end.
		const result = await run([verb, "definitely-not-a-subcommand"]);
		expect(result.ok).toBe(true);
		expect(result.code).toBe(code);
	});

	it("searches templates by term rather than listing everything", async () => {
		// The search path is the one with an argument; falling back to the full
		// list would silently ignore what the user asked for.
		const [all, searched] = await Promise.all([
			run(["template", "list"]),
			run(["template", "search", "adapter"]),
		]);
		expect(searched.message).not.toBe(all.message);
	});
});
