/**
 * `hobo-code` presentation — the layer between a result and a terminal.
 *
 * `formatHoboCodeResult` and `applyDenseChrome` are pure, and they carry more
 * responsibility than pure formatters usually do, because this CLI's panels
 * are self-branding: a panel that already names its own failure code must not
 * get a second one stapled underneath, and a panel that names nothing must get
 * one, or a failing command exits with a message an operator cannot look up.
 * The whole file is about that one decision made correctly in each of its
 * cases.
 *
 * Two invariants sit underneath everything here:
 *
 * **JSON is the machine contract.** `--json` must emit parseable JSON for every
 * result, including failures, and must never carry the human chrome — a glyph
 * inside a JSON field is a glyph inside somebody's `jq` pipeline. Absent
 * `remediation` and `data` are *omitted* rather than emitted as `null`, so a
 * consumer can tell "no remediation" from "remediation is null".
 *
 * **Dense is opt-in.** The help text promises plain English by default, and
 * unfamiliar developers are the default audience. Glyph chrome appears only
 * when it was asked for — by flag, by environment, or by a result that carries
 * `dense: true` in its own data because the verb already rendered dense.
 *
 * `suggestVerbTypo` and `looksLikeUnknownVerbAttempt` share this file because
 * they answer the same question from the other end: what a user meant when
 * they typed something that is not a verb, and whether a bare token should be
 * treated as a typo at all rather than as the prompt it probably is.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import {
	applyDenseChrome,
	formatHoboCodeResult,
	HOBO_CODE_VERBS,
	type HoboCodeCliResult,
	looksLikeUnknownVerbAttempt,
	runHoboCodeCli,
	suggestVerbTypo,
} from "../src/index.js";

const temps: string[] = [];

afterEach(() => {
	for (const dir of temps.splice(0)) {
		// `maxRetries` because the CLI writes into these trees and an unlink can
		// land while a descendant is still being created, which surfaces as an
		// ENOTEMPTY teardown failure on a test whose assertions all passed.
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

/**
 * An environment with an isolated `HOME`.
 *
 * A bare `{}` is not isolation. `defaultHoboHome` falls back to
 * `join(env.HOME ?? tmpdir(), ".hobo")`, so an env with no HOME resolves to
 * `/tmp/.hobo` — a *shared* directory every process on the machine can see.
 * That is bad on its own, and worse here: `.hobo` is one of the markers the
 * `hobo` CLI walks up the tree looking for, so creating it turns `/tmp` into
 * "a HoBo project" and makes `packages/cli`'s no-Bindle test fail for anyone
 * whose /tmp has ever been touched by this code. Pointing HOME at a directory
 * this file owns keeps every fallback inside the sandbox.
 */
function isolatedEnv(): NodeJS.ProcessEnv {
	return { HOME: temp("hobo-code-fallback-home-") };
}

function result(overrides: Partial<HoboCodeCliResult> = {}): HoboCodeCliResult {
	return {
		ok: true,
		status: "ok",
		code: "HOBO_CODE_OK",
		message: "it worked",
		exitCode: 0,
		...overrides,
	};
}

/** A closed panel, as `panel()` builds them: title, body, trailing rule. */
function panel(title: string, body: string, ruleWidth = 16): string {
	return `${title}\n ${body}\n${"─".repeat(ruleWidth)}`;
}

describe("the JSON contract", () => {
	it("emits parseable JSON", () => {
		expect(() =>
			JSON.parse(formatHoboCodeResult(result(), true)),
		).not.toThrow();
	});

	it("emits parseable JSON for a failure too", () => {
		// A CLI that emits JSON on success and prose on failure forces every
		// caller to write two parsers, so most write one and break on errors.
		expect(() =>
			JSON.parse(
				formatHoboCodeResult(
					result({ ok: false, code: "HOBO_CODE_USAGE", exitCode: 2 }),
					true,
				),
			),
		).not.toThrow();
	});

	it("carries the fields a caller branches on", () => {
		const parsed = JSON.parse(formatHoboCodeResult(result(), true));
		expect(parsed).toMatchObject({
			ok: true,
			status: "ok",
			code: "HOBO_CODE_OK",
			message: "it worked",
		});
	});

	it("omits remediation rather than emitting null", () => {
		// An absent key and a null value are different facts; a consumer that
		// saw neither could not tell "nothing to suggest" from "suggestion
		// unavailable".
		const parsed = JSON.parse(formatHoboCodeResult(result(), true));
		expect(parsed).not.toHaveProperty("remediation");
	});

	it("omits data rather than emitting null", () => {
		const parsed = JSON.parse(formatHoboCodeResult(result(), true));
		expect(parsed).not.toHaveProperty("data");
	});

	it("includes remediation when there is some", () => {
		const parsed = JSON.parse(
			formatHoboCodeResult(result({ remediation: ["do the thing"] }), true),
		);
		expect(parsed.remediation).toEqual(["do the thing"]);
	});

	it("includes data when there is some", () => {
		const parsed = JSON.parse(
			formatHoboCodeResult(result({ data: { taskId: "task-1" } }), true),
		);
		expect(parsed.data).toEqual({ taskId: "task-1" });
	});

	it("never adds the human failure trailer to JSON", () => {
		// A glyph inside a JSON field lands inside somebody's jq pipeline.
		const text = formatHoboCodeResult(
			result({ ok: false, code: "HOBO_CODE_USAGE" }),
			true,
		);
		expect(text).not.toContain("✕");
	});

	it("never adds the success trailer to JSON", () => {
		expect(formatHoboCodeResult(result(), true)).not.toContain("✓");
	});

	it("ends with a newline so a shell prompt starts on its own line", () => {
		expect(formatHoboCodeResult(result(), true).endsWith("\n")).toBe(true);
	});

	it("accepts the options-object form as well as the boolean", () => {
		// The boolean form is the older one and still in use at call sites.
		expect(formatHoboCodeResult(result(), { json: true })).toBe(
			formatHoboCodeResult(result(), true),
		);
	});
});

describe("branding a failure", () => {
	it("appends the code when the body names nothing", () => {
		// A failing command whose output does not carry its code leaves the
		// operator with prose they cannot look up or search.
		const text = formatHoboCodeResult(
			result({ ok: false, code: "HOBO_CODE_USAGE", message: "bad usage" }),
		);
		expect(text).toContain("✕ HOBO_CODE_USAGE");
	});

	it("does not repeat a code the body already names", () => {
		const text = formatHoboCodeResult(
			result({
				ok: false,
				code: "HOBO_CODE_USAGE",
				message: "HOBO_CODE_USAGE: bad usage",
			}),
		);
		expect(text.match(/HOBO_CODE_USAGE/gu)).toHaveLength(1);
	});

	it("accepts the short form of the code as branding", () => {
		// Panels print `USAGE` rather than `HOBO_CODE_USAGE`; treating those as
		// unbranded would staple the long form under a panel that already says
		// the same thing.
		const text = formatHoboCodeResult(
			result({ ok: false, code: "HOBO_CODE_USAGE", message: "✕ USAGE here" }),
		);
		expect(text).not.toContain("HOBO_CODE_USAGE");
	});

	it("accepts an existing glyph-marked failure as branding", () => {
		const text = formatHoboCodeResult(
			result({ ok: false, code: "HOBO_CODE_DIST_OFF", message: "✕ dist off" }),
		);
		expect(text).not.toContain("HOBO_CODE_DIST_OFF");
	});

	it.each([
		"FIX →",
		"FIX  →",
	])("accepts an existing %s row as branding", (marker) => {
		const text = formatHoboCodeResult(
			result({
				ok: false,
				code: "HOBO_CODE_USAGE",
				message: `something failed\n${marker} run help`,
			}),
		);
		expect(text).not.toContain("✕ HOBO_CODE_USAGE");
	});

	it("tucks the code inside a closed panel rather than below it", () => {
		// A code printed after the bottom rule reads as a separate message; the
		// panel is the unit an operator scans.
		const text = formatHoboCodeResult(
			result({
				ok: false,
				code: "HOBO_CODE_USAGE",
				message: panel("failed", "that did not work"),
			}),
		);
		const lines = text.trimEnd().split("\n");
		expect(lines.at(-1)).toMatch(/^─+$/u);
		expect(lines.at(-2)).toBe("✕ HOBO_CODE_USAGE");
	});

	it("treats a glyph-marked panel title as branding on its own", () => {
		// A panel whose title already reads `✕ cmd` has announced the failure in
		// the place an operator looks first. Stapling a code under it would make
		// every failing panel say the same thing twice — and the panels that
		// carry a ✕ title are exactly the ones a verb rendered deliberately.
		const text = formatHoboCodeResult(
			result({
				ok: false,
				code: "HOBO_CODE_USAGE",
				message: panel("✕ cmd", "that did not work"),
			}),
		);
		expect(text).not.toContain("HOBO_CODE_USAGE");
	});

	it("never brands a help result as a failure", () => {
		// Help is not an error even when it is printed because something went
		// wrong, and an exit code plus a ✕ on a help screen reads as broken.
		const text = formatHoboCodeResult(
			result({ ok: false, code: "HOBO_CODE_HELP", message: "usage: …" }),
		);
		expect(text).not.toContain("✕");
	});
});

describe("branding a success", () => {
	it("appends the code when the body brands nothing", () => {
		expect(formatHoboCodeResult(result())).toContain("✓ HOBO_CODE_OK");
	});

	it("stays quiet when the body already names the code", () => {
		const text = formatHoboCodeResult(
			result({ message: "HOBO_CODE_OK: done" }),
		);
		expect(text.match(/HOBO_CODE_OK/gu)).toHaveLength(1);
	});

	it("stays quiet when the body names the product", () => {
		// `hobo-code …` in the body is already the brand; a trailing code would
		// be a second seal on the same panel.
		expect(
			formatHoboCodeResult(result({ message: "run hobo-code status next" })),
		).not.toContain("✓ HOBO_CODE_OK");
	});

	it("stays quiet under a closed panel, whose rule is the seal", () => {
		expect(
			formatHoboCodeResult(result({ message: panel("✓ done", "all good") })),
		).not.toContain("✓ HOBO_CODE_OK");
	});

	it("stays quiet under a box-drawn panel", () => {
		expect(
			formatHoboCodeResult(result({ message: "┌ status\n│ fine" })),
		).not.toContain("✓ HOBO_CODE_OK");
	});

	it("stays quiet under a session strip", () => {
		// `se·` is the session verb's own tail; it brands the panel already.
		expect(
			formatHoboCodeResult(result({ message: "se·running·st" })),
		).not.toContain("✓ HOBO_CODE_OK");
	});

	it("separates the trailer from the body with a blank line", () => {
		// Run together, the code reads as part of the message.
		const lines = formatHoboCodeResult(result()).trimEnd().split("\n");
		expect(lines.at(-2)).toBe("");
	});
});

describe("remediation", () => {
	it("renders remediation as a FIX row", () => {
		const text = formatHoboCodeResult(
			result({ ok: false, code: "HOBO_CODE_USAGE", remediation: ["run help"] }),
		);
		expect(text).toContain("FIX  → run help");
	});

	it("joins several suggestions on one row", () => {
		// One line per suggestion would push the panel off a short terminal and
		// bury the first one, which is usually the one that works.
		const text = formatHoboCodeResult(
			result({ ok: false, code: "HOBO_CODE_USAGE", remediation: ["a", "b"] }),
		);
		expect(text).toContain("FIX  → a · → b");
	});

	it("carries the failure code on the FIX row", () => {
		const text = formatHoboCodeResult(
			result({ ok: false, code: "HOBO_CODE_USAGE", remediation: ["a"] }),
		);
		expect(text).toContain("✕ HOBO_CODE_USAGE");
	});

	it("omits the code on a successful result with remediation", () => {
		// A success with advice attached is not a failure, and a ✕ next to
		// working output is the fastest way to make an operator distrust output.
		const text = formatHoboCodeResult(result({ remediation: ["consider x"] }));
		expect(text).not.toContain("✕");
	});

	it("tucks the FIX row inside a closed panel", () => {
		const text = formatHoboCodeResult(
			result({
				ok: false,
				code: "HOBO_CODE_USAGE",
				message: panel("✕ cmd", "no good"),
				remediation: ["run help"],
			}),
		);
		const lines = text.trimEnd().split("\n");
		expect(lines.at(-1)).toMatch(/^─+$/u);
		expect(lines.at(-2)).toContain("FIX  → run help");
	});

	it("appends its own rule when the body is not a closed panel", () => {
		// Without one the FIX row floats loose under prose.
		const text = formatHoboCodeResult(
			result({
				ok: false,
				code: "HOBO_CODE_USAGE",
				message: "plain prose",
				remediation: ["run help"],
			}),
		);
		expect(text.trimEnd().split("\n").at(-1)).toMatch(/^─+$/u);
	});

	it("treats an empty remediation list as none at all", () => {
		// An empty FIX row is worse than no FIX row.
		const text = formatHoboCodeResult(
			result({ ok: false, code: "HOBO_CODE_USAGE", remediation: [] }),
		);
		expect(text).not.toContain("FIX");
	});
});

describe("choosing the body", () => {
	it("prefers the presentation text a verb rendered", () => {
		// Verbs that build their own panel put it in `data.text`; the message is
		// the one-line summary for logs and JSON.
		const text = formatHoboCodeResult(
			result({ message: "summary", data: { text: "the rendered panel" } }),
		);
		expect(text).toContain("the rendered panel");
		expect(text).not.toContain("summary");
	});

	it("falls back to the message when the rendered text is empty", () => {
		// An empty string is not a panel; printing it would print nothing.
		expect(
			formatHoboCodeResult(result({ message: "summary", data: { text: "" } })),
		).toContain("summary");
	});

	it("falls back to the message when data carries no text", () => {
		expect(
			formatHoboCodeResult(result({ message: "summary", data: { other: 1 } })),
		).toContain("summary");
	});
});

describe("help output", () => {
	it("passes help through untouched", () => {
		// `helpText()` already chose plain or dense; a second pass would compress
		// a screen the user asked to read.
		const text = formatHoboCodeResult(
			result({ code: "HOBO_CODE_HELP", message: "usage: hobo-code <verb>" }),
		);
		expect(text).toBe("usage: hobo-code <verb>\n");
	});

	it("does not double the trailing newline", () => {
		const text = formatHoboCodeResult(
			result({ code: "HOBO_CODE_HELP", message: "usage\n" }),
		);
		expect(text).toBe("usage\n");
	});
});

describe("dense chrome", () => {
	it("is off unless asked for", () => {
		// The help promises plain English by default, and unfamiliar developers
		// are the default audience.
		expect(formatHoboCodeResult(result({ message: "▣ isolate" }))).toContain(
			"▣ isolate",
		);
	});

	it("turns on by option", () => {
		expect(
			formatHoboCodeResult(result({ message: "▣ isolate" }), { dense: true }),
		).toContain("▣ i");
	});

	it("turns on when the result's own data says it rendered dense", () => {
		// A verb that already built a dense panel carries the flag with it, so a
		// caller that did not pass `dense` still gets a consistent screen.
		expect(
			formatHoboCodeResult(
				result({ message: "▣ isolate", data: { dense: true } }),
			),
		).toContain("▣ i");
	});

	it("is not turned on by a falsy dense flag in the data", () => {
		expect(
			formatHoboCodeResult(
				result({ message: "▣ isolate", data: { dense: false } }),
			),
		).toContain("▣ isolate");
	});

	it("survives data that is not an object", () => {
		// `data` is `unknown`; a string or a number there must not crash the
		// formatter on the way to the terminal.
		expect(() =>
			formatHoboCodeResult(result({ message: "x", data: "a string" })),
		).not.toThrow();
	});

	it("survives null data", () => {
		expect(() =>
			formatHoboCodeResult(result({ message: "x", data: null })),
		).not.toThrow();
	});
});

describe("applyDenseChrome", () => {
	it.each([
		["▣ isolate", "▣ i"],
		["✓ promote", "✓ pr"],
		["✕ promote", "✕ pr"],
		["✕ isolate", "✕ i"],
		["✕ session", "✕ se"],
		["✕ distributed", "✕ dist"],
		["◎ attach", "◎ at"],
		["◎ resume", "◎ re"],
		["▣ agents", "▣ ag"],
		["▣ tasks", "▣ tk"],
		["◈ cost", "◈ $"],
		["◈ harness", "◈ hz"],
		["◈ config", "◈ cfg"],
	])("compresses the %s title to %s", (title, compressed) => {
		expect(applyDenseChrome(title)).toBe(compressed);
	});

	it("compresses a title only on the first line", () => {
		// The same words further down are body text, not a title, and rewriting
		// them would mangle a sentence that happens to mention a verb.
		expect(applyDenseChrome("something\n▣ isolate")).toBe(
			"something\n▣ isolate",
		);
	});

	it("leaves a title it does not know alone", () => {
		expect(applyDenseChrome("▣ unknown-verb")).toBe("▣ unknown-verb");
	});

	it("compresses the promote next-step, keeping its argument", () => {
		// The argument is the whole point of the row; compressing it away would
		// leave the user with a command they cannot run.
		expect(applyDenseChrome(" next · hobo-code promote wip-1")).toBe(
			" next · pr wip-1",
		);
	});

	it("compresses the status next-step", () => {
		expect(applyDenseChrome(" next · hobo-code status")).toBe(" next · st");
	});

	it("compresses the help pointer", () => {
		expect(applyDenseChrome(" try · hobo-code help")).toBe(" try · help");
	});

	it("compresses a did-you-mean row to its glyph", () => {
		expect(applyDenseChrome(" did you mean · dispatch")).toBe(" ≈ dispatch");
	});

	it("compresses an unknown row to its glyph", () => {
		expect(applyDenseChrome(" unknown · frobnicate")).toBe(" ? frobnicate");
	});

	it("leaves an unrelated line untouched", () => {
		expect(applyDenseChrome(" task · task-1")).toBe(" task · task-1");
	});

	it("leaves an empty message alone", () => {
		expect(applyDenseChrome("")).toBe("");
	});

	it("preserves line count", () => {
		// The panel's shape is load-bearing: a dropped line would break the rule
		// that closes it.
		const message = "▣ isolate\n····\n body\n────";
		expect(applyDenseChrome(message).split("\n")).toHaveLength(4);
	});
});

describe("suggesting a verb the user meant", () => {
	it.each([
		["stauts", "status"],
		["sesion", "session"],
		["revie", "review"],
		["confg", "config"],
	])("suggests %s → %s", (typo, verb) => {
		expect(suggestVerbTypo(typo)).toBe(verb);
	});

	it.each([
		"dispatchh",
		"hlep",
	])("never suggests dispatch or help, so %s gets nothing", (typo) => {
		// Both are excluded on purpose. `dispatch` is what a non-verb token
		// already does, so "did you mean dispatch?" describes the thing that
		// is about to happen anyway. `help` is one keystroke from everything —
		// it would win the distance race against real verbs and bury the
		// suggestion the user actually needed.
		expect(suggestVerbTypo(typo)).toBeNull();
	});

	it("requires a closer match from a short token", () => {
		// One edit in four characters is most of the word. The threshold tightens
		// for short tokens because at that length nearly everything is within two
		// edits of something, and a confident wrong suggestion is worse than
		// silence.
		// One insertion is offered; a transposition — two edits — is not.
		expect(suggestVerbTypo("envv")).toBe("env");
		expect(suggestVerbTypo("evn")).toBeNull();
	});

	it("suggests nothing for a token with a separator in it", () => {
		// Those go down the invented-command path instead, which says "unknown"
		// rather than guessing.
		expect(suggestVerbTypo("run-tests")).toBeNull();
	});

	it("suggests nothing for a token that resembles no verb", () => {
		// A wrong suggestion is worse than none: it sends the user to run a
		// command they did not want.
		expect(suggestVerbTypo("xyzzy-quux-frobnicate")).toBeNull();
	});

	it("suggests nothing for an exact verb", () => {
		// It is not a typo, and "did you mean status?" for `status` reads as a
		// broken CLI.
		expect(suggestVerbTypo("status")).toBeNull();
	});

	it("suggests nothing for an empty token", () => {
		expect(suggestVerbTypo("")).toBeNull();
	});

	it("only ever suggests a real verb", () => {
		// A suggestion the CLI would itself reject is a dead end.
		for (const typo of ["dispatc", "statu", "sessin", "revie", "confg"]) {
			const suggestion = suggestVerbTypo(typo);
			if (suggestion !== null) {
				expect(HOBO_CODE_VERBS).toContain(suggestion);
			}
		}
	});
});

describe("deciding a token was a mistyped verb", () => {
	// The stakes are asymmetric, and the rule reflects it. `hobo-code fix the
	// login bug` is a prompt; refusing it as a typo would reject work the user
	// meant. So the test is narrow on purpose: a single token *with a separator
	// in it* — `run-tests`, `list_files` — which is a shape natural language
	// does not produce and an invented command name does. A GUI-native user
	// guessing at a command deserves "unknown", not a compute task dispatched
	// with their guess as the prompt.
	//
	// A plain misspelled word like `stauts` deliberately does *not* qualify:
	// one-word natural language still dispatches, and the typo suggestion is
	// surfaced separately rather than by refusing the run.

	it.each([
		"run-tests",
		"list_files",
		"show-status",
	])("treats %s as an invented command name", (token) => {
		expect(looksLikeUnknownVerbAttempt(token)).toBe(true);
	});

	it("lets a plain misspelled word dispatch as a prompt", () => {
		expect(looksLikeUnknownVerbAttempt("stauts")).toBe(false);
	});

	it("does not treat a real verb as an invented one", () => {
		// `hobo-code dashboard` is a verb, separators and all.
		expect(looksLikeUnknownVerbAttempt("dashboard")).toBe(false);
	});

	it("does not treat a two-character token as an invented command", () => {
		// Too short to carry an intent, and a stray argument is more likely.
		expect(looksLikeUnknownVerbAttempt("a-")).toBe(false);
	});

	it("does not treat a multi-word prompt as a mistyped verb", () => {
		expect(looksLikeUnknownVerbAttempt("fix the login bug")).toBe(false);
	});

	it("does not treat a sentence with punctuation as a mistyped verb", () => {
		expect(looksLikeUnknownVerbAttempt("why is this broken?")).toBe(false);
	});

	it("does not treat an empty token as a mistyped verb", () => {
		// An empty argv is the bare-dispatch path, not a typo.
		expect(looksLikeUnknownVerbAttempt("")).toBe(false);
	});

	it("does not treat a flag as a mistyped verb", () => {
		expect(looksLikeUnknownVerbAttempt("--json")).toBe(false);
	});

	it("does not treat a path as a mistyped verb", () => {
		// A path is a plausible thing to hand a prompt-taking CLI.
		expect(looksLikeUnknownVerbAttempt("./src/index.ts")).toBe(false);
	});
});

describe("every verb, run bare", () => {
	// A verb that throws on its own name is a verb nobody can discover. This
	// sweep is deliberately shallow — it runs each verb with no arguments
	// against an empty isolated home and asserts only the contract every result
	// must satisfy — but it is the only test that covers *all* of them, and the
	// contract it checks is exactly what the shell and the exit code depend on.
	//
	// Several of these legitimately fail: `resume` with no session to resume,
	// `promote` with nothing named, `history` with nobody signed in. A failure
	// is a fine outcome. Throwing, or reporting a code the caller cannot branch
	// on, is not.

	async function runBare(verb: string) {
		return runHoboCodeCli([verb], {
			env: { ...isolatedEnv(), HOBO_CODE_SIDECARS: "0" },
			hoboHome: temp("hobo-code-verb-home-"),
			cwd: temp("hobo-code-verb-cwd-"),
			allocateWorkspaces: async ({ workspaceRoot, agentIds }) => ({
				backend: "shared",
				workspaces: agentIds.map((agentId) => ({
					agentId,
					path: workspaceRoot,
					backend: "shared",
				})),
			}),
			muxRunner: { run: async () => ({ code: 0, stdout: "hobo\n" }) },
			// An stdin that is already at EOF.
			//
			// `vshell` owns stdin for the life of its pane and returns when stdin
			// closes — right for a terminal, but under vitest `process.stdin`
			// never ends, so the verb ran until the timeout and the sweep failed
			// on it. Handing it a stream that is immediately done makes the pane
			// open and close, which is exactly the bounded run this contract
			// check wants.
			//
			// Supplied to every verb rather than just this one: a verb that grows
			// a stdin read later should get the same bounded treatment without
			// anyone having to remember to come back here.
			input: Readable.from([]),
		});
	}

	// One run per verb, every assertion against that run. Six separate runs
	// would be six copies of the slowest verbs' setup for no extra signal.
	it.each(
		HOBO_CODE_VERBS,
	)("honours the result contract for %s", async (verb) => {
		const outcome = await runBare(verb);

		// Namespaced, so a caller can tell this CLI's failures from a shell's
		// or a harness's.
		expect(outcome.code).toMatch(/^HOBO_/u);

		// An empty message with a non-zero exit is the worst possible
		// outcome: the shell reports failure and offers nothing to act on.
		expect(outcome.message.trim().length).toBeGreaterThan(0);

		// `ok` and `exitCode` are two spellings of one fact, read by two
		// different callers — the shell reads the code, the harness reads
		// `ok` — and a disagreement means one of them acts on the wrong
		// outcome.
		expect(outcome.exitCode === 0).toBe(outcome.ok);

		// `--json` is a machine contract; a verb whose data does not survive
		// serialisation breaks it only for the person piping it somewhere.
		expect(() => JSON.parse(formatHoboCodeResult(outcome, true))).not.toThrow();

		// And it has to render for a human without vanishing.
		const text = formatHoboCodeResult(outcome);
		expect(text.endsWith("\n")).toBe(true);
		expect(text.trim().length).toBeGreaterThan(0);
		// Runtime-probing verbs can exceed a minute on cold mounted filesystems.
	}, 180_000);
});

describe("what dispatch says it did", () => {
	// The dense form of this panel reads `✓ ★ / hello·st` — a status glyph,
	// eight characters of the user's own prompt echoed back, and a two-letter
	// pointer at another command. It says nothing about what `dispatch` did,
	// and "✓" reads as "your request was carried out" when what actually
	// happened is that a compute task was *recorded*. The plain form is the
	// default precisely because of that gap, and these tests hold it there.

	async function dispatch(
		args: readonly string[],
		options: { readonly dense?: boolean } = {},
	) {
		const hoboHome = temp("hobo-code-dispatch-home-");
		const cwd = temp("hobo-code-dispatch-cwd-");
		const outcome = await runHoboCodeCli(args, {
			env: isolatedEnv(),
			hoboHome,
			cwd,
			dense: options.dense,
		});
		// SAFETY: dispatch results carry optional human-readable text.
		const text = (outcome.data as { text?: string } | undefined)?.text ?? "";
		return { outcome, text };
	}

	it("says a task was recorded, not that the work was done", async () => {
		// This is the whole point of the plain default: an agent has not run
		// anything, and nothing in the user's project has changed.
		const { text } = await dispatch(["dispatch", "refactor the parser"]);
		expect(text).toContain("No agent has run it yet");
	});

	it("says dispatch does not edit the project", async () => {
		const { text } = await dispatch(["dispatch", "refactor the parser"]);
		expect(text).toContain("it does not edit your project");
	});

	it("names the task so it can be found again", async () => {
		const { text } = await dispatch(["dispatch", "refactor the parser"]);
		expect(text).toMatch(/task · task-/u);
	});

	it("points at the board and at status", async () => {
		// A panel that reports something happened and offers no way to look at
		// it strands the user.
		const { text } = await dispatch(["dispatch", "refactor the parser"]);
		expect(text).toContain("hobo-code tasks");
		expect(text).toContain("hobo-code status");
	});

	it.each([
		[["dispatch"]],
		[[]],
	])("refuses %s with no prompt and no terminal", async (args) => {
		// With a TTY this opens the interactive shell. Without one — a script,
		// a CI job, a pipe — there is nobody to ask, and the alternatives are
		// both bad: hanging on a read that never comes, or recording a compute
		// task carrying an empty request that nobody can act on. Refusing is
		// the third option, and it is the right one.
		const { outcome } = await dispatch(args);
		expect(outcome.ok).toBe(false);
		expect(outcome.code).toBe("HOBO_CODE_INTERACTIVE_REQUIRED");
	});

	it("says a terminal is what was missing", async () => {
		// "Invalid input" would send the user looking at their prompt; the
		// actual problem is the environment they ran it in.
		const { outcome } = await dispatch(["dispatch"]);
		expect(outcome.message).toContain("needs a TTY");
	});

	it("offers both ways out of the refusal", async () => {
		// Read the help, or supply a prompt — the two things that work from a
		// non-interactive shell.
		const { outcome } = await dispatch(["dispatch"]);
		expect(outcome.message).toContain("hobo-code help");
		expect(outcome.message).toContain("provide a prompt");
	});

	it("compresses to a scan line under dense", async () => {
		const { text } = await dispatch(["dispatch", "refactor the parser"], {
			dense: true,
		});
		expect(text).not.toContain("No agent has run it yet");
		expect(text.split("\n").length).toBeLessThan(6);
	});

	it("marks a defaulted bare prompt differently from a typed verb", async () => {
		// `★` distinguishes "you typed dispatch" from "we inferred it", which is
		// the difference between a command and a guess. A bare prompt with no
		// verb takes the inferred path.
		const explicit = await dispatch(["dispatch", "refactor the parser"], {
			dense: true,
		});
		const inferred = await dispatch(["refactor the parser"], { dense: true });
		expect(inferred.text).toContain("★");
		expect(explicit.text).not.toContain("★");
	});

	it("omits the pool row on the default pool", async () => {
		// Every dispatch lands in `default`; printing it every time is a row
		// that never carries information.
		const { text } = await dispatch(["dispatch", "refactor the parser"]);
		expect(text).not.toContain("pool · default");
	});

	it("keeps the full task id in the data even when the panel shortens it", async () => {
		// The panel is for scanning; the data is what a script correlates on.
		const { outcome, text } = await dispatch([
			"dispatch",
			"refactor the parser",
		]);
		// SAFETY: dispatch results carry an optional task with its full identifier.
		const taskId = (outcome.data as { task?: { taskId?: string } } | undefined)
			?.task?.taskId;
		expect(taskId).toMatch(/^task-/u);
		expect(text).toContain(String(taskId));
	});
});

describe("per-verb help", () => {
	// Every verb is reachable from `hobo-code help <verb>`. A verb with no help
	// entry would throw on the way to the screen — the one command a confused
	// user is guaranteed to type.

	it.each(
		HOBO_CODE_VERBS.filter((verb) => verb !== "help"),
	)("renders plain help for %s", async (verb) => {
		const outcome = await runHoboCodeCli(["help", verb], {
			env: isolatedEnv(),
		});
		expect(outcome.ok).toBe(true);
		expect(outcome.message.length).toBeGreaterThan(0);
	});

	it.each(
		HOBO_CODE_VERBS.filter((verb) => verb !== "help"),
	)("renders dense help for %s", async (verb) => {
		const outcome = await runHoboCodeCli(["help", verb], {
			env: isolatedEnv(),
			dense: true,
		});
		expect(outcome.ok).toBe(true);
		expect(outcome.message).toContain(verb);
	});

	it("points from dense help back at the plain form", async () => {
		// Dense help is a reminder for someone who already knows the verb; the
		// person who does not needs a way back to the prose.
		const outcome = await runHoboCodeCli(["help", "dispatch"], {
			env: isolatedEnv(),
			dense: true,
		});
		expect(outcome.message).toContain("hobo-code dispatch --help");
	});

	it("names the verb's dense tail", async () => {
		// The tail is what the dense panels print; help is where you learn it.
		const outcome = await runHoboCodeCli(["help", "status"], {
			env: isolatedEnv(),
			dense: true,
		});
		expect(outcome.message).toContain("tail st");
	});

	it("falls back to the verb itself when it has no assigned tail", async () => {
		// Better a long tail than a crash or a blank.
		const outcome = await runHoboCodeCli(["help", "machines"], {
			env: isolatedEnv(),
			dense: true,
		});
		expect(outcome.message).toContain("tail machines");
	});

	it("renders top-level help for the bare help verb", async () => {
		const outcome = await runHoboCodeCli(["help"], { env: isolatedEnv() });
		expect(outcome.code).toBe("HOBO_CODE_HELP");
	});

	it("renders top-level dense help for the bare help verb", async () => {
		const outcome = await runHoboCodeCli(["help"], {
			env: isolatedEnv(),
			dense: true,
		});
		expect(outcome.code).toBe("HOBO_CODE_HELP");
	});

	it("reports help as a success rather than a usage error", async () => {
		// Someone asking for help has not made a mistake, and a non-zero exit
		// here breaks `hobo-code help && …` in a script.
		const outcome = await runHoboCodeCli(["help"], { env: isolatedEnv() });
		expect(outcome.ok).toBe(true);
		expect(outcome.exitCode).toBe(0);
	});
});
