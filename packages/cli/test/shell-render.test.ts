/**
 * Rendering a command result to stdout, stderr, and an exit code.
 *
 * This is the last thing that happens before the process exits, and three rules
 * govern it.
 *
 * **`-q` suppresses success chrome, never failure signal.** A script running
 * quietly still has to learn *why* a command failed, so an error message goes to
 * stderr even under `-q`. Suppressing it would leave a failing CI job with an
 * exit code and no explanation — the single most frustrating way for a build to
 * break.
 *
 * **JSON goes to stdout, human errors go to stderr.** A script pipes stdout into
 * a parser, so a human-readable error printed there would corrupt the stream it
 * was trying to help with. Under `--json` the envelope *is* the error report and
 * belongs on stdout; without it, errors belong on stderr where a pipe does not
 * see them.
 *
 * **An unexpected error says nothing about itself unless asked.** An internal
 * failure prints a fixed message and points at `--verbose`, because an arbitrary
 * exception's message and stack can carry paths, arguments, and occasionally
 * credentials. `--verbose` is the user opting into that.
 */
import { describe, expect, it } from "vitest";

import { CliError, UsageError } from "../src/shell/errors.js";
import { parseArgv } from "../src/shell/parse.js";
import {
	envelopeToRunResult,
	renderError,
	renderSuccess,
} from "../src/shell/render.js";
import { buildEnvelope } from "../src/types/envelope.js";

const CONTEXT = {
	cwd: "/work",
	projectDir: "/work/app",
	identity: null,
	clients: { readApi: "http://read", runtime: "http://runtime" },
};

/** Flags as the parser would produce them for `hobo <verb> [tokens]`. */
function flagsFor(...tokens: string[]) {
	return parseArgv(["up", ...tokens], { cwd: "/work" }).flags;
}

function success(
	result: Record<string, unknown>,
	tokens: string[] = [],
	verb = "up",
) {
	return renderSuccess({
		verb,
		flags: flagsFor(...tokens),
		context: CONTEXT,
		result,
	});
}

describe("rendering a successful command", () => {
	it("exits zero and prints a status table", () => {
		const rendered = success({ message: "deployed" });
		expect(rendered.exitCode).toBe(0);
		expect(rendered.stdout).toContain("Command");
		expect(rendered.stdout).toContain("deployed");
		expect(rendered.stderr).toBe("");
	});

	it("names the verb in the table", () => {
		expect(success({}, [], "doctor").stdout).toContain("doctor");
	});

	it("prints the envelope as one JSON line under --json", () => {
		// One line, newline-terminated: a consumer reads a line and parses it.
		// Pretty-printed JSON would need a streaming parser for no benefit.
		const rendered = success({ message: "deployed" }, ["--json"]);
		expect(rendered.stdout.endsWith("\n")).toBe(true);
		expect(rendered.stdout.trimEnd()).not.toContain("\n");
		expect(JSON.parse(rendered.stdout)).toMatchObject({
			ok: true,
			verb: "up",
			message: "deployed",
		});
	});

	it("prints nothing at all under -q on success", () => {
		// The whole point of quiet: a script that only cares about the exit code
		// gets a clean stream.
		const rendered = success({ message: "deployed" }, ["-q"]);
		expect(rendered.stdout).toBe("");
		expect(rendered.stderr).toBe("");
		expect(rendered.exitCode).toBe(0);
	});

	it("renders the new-project next steps", () => {
		// `hobo new` is the one verb whose output is a set of instructions rather
		// than a status. Rendering it as a status table would leave a new user
		// with a created project and no idea what to run.
		const rendered = success(
			{ data: { name: "my-app", nextSteps: ["cd my-app", "hobo dev --once"] } },
			[],
			"new",
		);
		expect(rendered.stdout).toContain("Created HoBo project my-app");
		expect(rendered.stdout).toContain("cd my-app");
		expect(rendered.stdout).toContain("hobo dev --once");
	});

	it("renders a new project whose steps are missing or malformed", () => {
		// `Array.isArray(...) ? … : ""`. A command that reported no steps must
		// still print the creation line rather than crashing on a join.
		for (const nextSteps of [undefined, "cd my-app", 7, null]) {
			const rendered = success(
				{ data: { name: "my-app", nextSteps } },
				[],
				"new",
			);
			expect(rendered.stdout).toContain("Created HoBo project my-app");
		}
	});

	it("renders a new project with no name rather than printing undefined", () => {
		// `String(… ?? "")`. Without it the line would read "Created HoBo project
		// undefined", which looks like a bug in the tool rather than a missing
		// field.
		expect(success({ data: {} }, [], "new").stdout).not.toContain("undefined");
	});

	it("uses the JSON envelope for a new project under --json", () => {
		// The human next-steps rendering must not leak into the machine lane —
		// a script parsing stdout would fail on prose.
		const rendered = success(
			{ data: { name: "my-app", nextSteps: ["cd my-app"] } },
			["--json"],
			"new",
		);
		expect(() => JSON.parse(rendered.stdout)).not.toThrow();
	});
});

describe("rendering a command that reported failure", () => {
	it("exits one for an ordinary failure", () => {
		expect(success({ ok: false, message: "no camp" }).exitCode).toBe(1);
	});

	it("exits two for a usage failure", () => {
		// Two is the conventional shell exit for misuse. A script branching on it
		// distinguishes "I invoked this wrong" from "it ran and failed", which
		// call for different responses.
		for (const code of ["HOBO_BUILD_USAGE", "HOBO_CLI_USAGE"]) {
			expect(success({ ok: false, code }).exitCode).toBe(2);
		}
	});

	it("exits one for a non-usage code", () => {
		expect(success({ ok: false, code: "HOBO_DRIFT" }).exitCode).toBe(1);
	});

	it("prints the failure message to stderr even under -q", () => {
		// The rule this file exists for. Suppressing it would leave a failing CI
		// job with an exit code and no explanation.
		const rendered = success({ ok: false, message: "no camp configured" }, [
			"-q",
		]);
		expect(rendered.stderr).toContain("no camp configured");
		expect(rendered.stdout).toBe("");
		expect(rendered.exitCode).toBe(1);
	});

	it("keeps the failing exit code under --json", () => {
		const rendered = success({ ok: false, message: "no camp" }, ["--json"]);
		expect(rendered.exitCode).toBe(1);
		expect(JSON.parse(rendered.stdout).ok).toBe(false);
	});
});

describe("rendering a typed CLI error", () => {
	const error = new UsageError('Unknown option "--nope".', [
		"Run `hobo up --help`.",
	]);

	it("prints the message to stderr, not stdout", () => {
		// stdout is the machine lane. A human-readable error printed there would
		// corrupt the stream a script was parsing.
		const rendered = renderError(error, { verb: "up", flags: flagsFor() });
		expect(rendered.stderr).toContain("Unknown option");
		expect(rendered.stdout).toBe("");
	});

	it("carries the error's own exit code", () => {
		// A usage error exits 2; the renderer must not flatten every failure to
		// 1 and lose the distinction the error type went to the trouble of
		// making.
		expect(renderError(error, { verb: "up", flags: flagsFor() }).exitCode).toBe(
			error.exitCode,
		);
	});

	it("emits an envelope on stdout under --json", () => {
		// Under `--json` the envelope *is* the error report, so it belongs on the
		// stream the consumer is reading.
		const rendered = renderError(error, {
			verb: "up",
			flags: flagsFor("--json"),
		});
		const parsed = JSON.parse(rendered.stdout);
		expect(parsed.ok).toBe(false);
		expect(parsed.code).toBe(error.code);
		expect(parsed.remediation).toEqual(["Run `hobo up --help`."]);
		expect(rendered.stderr).toBe("");
	});

	it("puts only the first line of a multi-line message in the envelope", () => {
		// The envelope's `message` is a summary field a consumer may render in
		// one line. A multi-line message there would break a table or a log
		// format that assumed one record per line.
		const rendered = renderError(
			new CliError("first line\nsecond line", 1, "HOBO_X", []),
			{ verb: "up", flags: flagsFor("--json") },
		);
		expect(JSON.parse(rendered.stdout).message).toBe("first line");
	});

	it("keeps a single-line message intact", () => {
		const rendered = renderError(new CliError("only line", 1, "HOBO_X", []), {
			verb: "up",
			flags: flagsFor("--json"),
		});
		expect(JSON.parse(rendered.stdout).message).toBe("only line");
	});

	it("reports an empty verb when the error happened before one was parsed", () => {
		// `input.verb ?? ""`. An `undefined` verb would vanish from the JSON, and
		// a consumer keying on it would see a record with no verb field at all.
		const rendered = renderError(error, {
			verb: null,
			flags: flagsFor("--json"),
		});
		expect(JSON.parse(rendered.stdout).verb).toBe("");
	});

	it("synthesises a context when none was established", () => {
		// An error can happen before the project is resolved. The envelope still
		// has to carry a context, because its shape is the contract.
		const rendered = renderError(error, {
			verb: "up",
			flags: flagsFor("--json"),
		});
		const parsed = JSON.parse(rendered.stdout);
		expect(parsed.context.projectDir).toBeNull();
		expect(parsed.context.cwd.length).toBeGreaterThan(0);
	});

	it("uses a supplied context when there is one", () => {
		const rendered = renderError(error, {
			verb: "up",
			flags: flagsFor("--json"),
			context: CONTEXT,
		});
		expect(JSON.parse(rendered.stdout).context.projectDir).toBe("/work/app");
	});
});

describe("rendering an unexpected error", () => {
	const boom = new Error("connect ECONNREFUSED 10.0.0.1:5432");

	it("exits one and says nothing specific without --verbose", () => {
		// An arbitrary exception's message can carry paths, arguments, and
		// occasionally credentials. The default is a fixed line plus a pointer.
		const rendered = renderError(boom, { verb: "up", flags: flagsFor() });
		expect(rendered.exitCode).toBe(1);
		expect(rendered.stderr).toContain("Internal CLI error");
		expect(rendered.stderr).toContain("--verbose");
		expect(rendered.stderr).not.toContain("10.0.0.1");
	});

	it("prints the stack when --verbose is given", () => {
		// The user opting in. Without this there would be no way to diagnose an
		// internal failure short of editing the CLI.
		const rendered = renderError(boom, {
			verb: "up",
			flags: flagsFor("--verbose"),
		});
		expect(rendered.stderr).toContain("ECONNREFUSED");
	});

	it("keeps stdout clean without --json", () => {
		expect(renderError(boom, { verb: "up", flags: flagsFor() }).stdout).toBe(
			"",
		);
	});

	it("emits an internal-error envelope under --json", () => {
		const rendered = renderError(boom, {
			verb: "up",
			flags: flagsFor("--json"),
		});
		const parsed = JSON.parse(rendered.stdout);
		expect(parsed.ok).toBe(false);
		expect(parsed.code).toBe("HOBO_CLI_INTERNAL");
		expect(parsed.message).not.toContain("10.0.0.1");
	});

	it("includes the detail in the envelope only under --verbose", () => {
		// Same opt-in, applied to the machine lane: a CI job capturing JSON
		// should not archive an exception message nobody asked for.
		const rendered = renderError(boom, {
			verb: "up",
			flags: flagsFor("--json", "--verbose"),
		});
		const parsed = JSON.parse(rendered.stdout);
		expect(parsed.message).toContain("ECONNREFUSED");
		expect(rendered.stderr).toContain("ECONNREFUSED");
	});

	it("gives different remediation with and without --verbose", () => {
		// Without it: re-run verbosely. With it: report what you already have.
		// Repeating "re-run with --verbose" at someone who did would be useless.
		const quiet = JSON.parse(
			renderError(boom, { verb: "up", flags: flagsFor("--json") }).stdout,
		);
		const verbose = JSON.parse(
			renderError(boom, {
				verb: "up",
				flags: flagsFor("--json", "--verbose"),
			}).stdout,
		);
		expect(quiet.remediation[0]).toContain("--verbose");
		expect(verbose.remediation[0]).not.toContain("--verbose");
	});

	it("handles a thrown value that is not an Error", () => {
		// `String(error)`. A thrown string or object must not crash the renderer,
		// which would replace a diagnosable failure with an unhandled one.
		for (const thrown of ["a string", { code: 7 }, null, undefined, 42]) {
			const rendered = renderError(thrown, {
				verb: "up",
				flags: flagsFor("--verbose"),
			});
			expect(rendered.exitCode).toBe(1);
			expect(rendered.stderr.length).toBeGreaterThan(0);
		}
	});

	it("falls back to the fixed message when verbose produced no diagnostics", () => {
		// The `diagnostics !== ""` arm: without `--verbose` there is nothing to
		// print, and an empty stderr would leave the user with a bare exit code.
		expect(
			renderError(boom, { verb: "up", flags: flagsFor() }).stderr.length,
		).toBeGreaterThan(0);
	});
});

describe("envelopeToRunResult", () => {
	const envelope = buildEnvelope({
		verb: "up",
		context: CONTEXT,
		result: { message: "deployed" },
	});

	it("prints the envelope verbatim under --json", () => {
		const rendered = envelopeToRunResult(envelope, flagsFor("--json"));
		expect(JSON.parse(rendered.stdout)).toEqual(envelope);
		expect(rendered.exitCode).toBe(0);
	});

	it("exits one for a failed envelope under --json", () => {
		const failed = buildEnvelope({
			verb: "up",
			context: CONTEXT,
			result: { ok: false },
		});
		expect(envelopeToRunResult(failed, flagsFor("--json")).exitCode).toBe(1);
	});

	it("renders the human form when --json is absent", () => {
		const rendered = envelopeToRunResult(envelope, flagsFor());
		expect(rendered.stdout).toContain("deployed");
		expect(() => JSON.parse(rendered.stdout)).toThrow();
	});

	it("renders the envelope's own verb, not the caller's", () => {
		// The envelope is the record of what ran. Re-deriving the verb from
		// anywhere else could label a result with the wrong command.
		const doctor = buildEnvelope({
			verb: "doctor",
			context: CONTEXT,
			result: {},
		});
		expect(envelopeToRunResult(doctor, flagsFor()).stdout).toContain("doctor");
	});
});
