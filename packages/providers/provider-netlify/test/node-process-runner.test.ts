/**
 * The Node `child_process` adapter behind the CLI seam.
 *
 * This is the one place in the adapter that starts an operating-system
 * process, and the security property is stated in the source: `shell` is left
 * at `false` and the argv is split into file-plus-arguments, so **no part of
 * it is ever parsed by a shell**. Site names, deploy messages and directory
 * paths all reach this function from user input; with `shell: true` a name
 * containing `;` or `$(…)` would execute. The tests below run real processes
 * to prove that end-to-end rather than asserting the option in isolation.
 *
 * The output cap is the other guard. The CLI's output is unbounded from this
 * package's point of view, and a runaway process would otherwise accumulate
 * into a string until the host ran out of memory. The cap *rejects* rather
 * than returning truncated output, because a truncated deploy log parsed as
 * though it were complete is how a claim URL goes missing without anyone
 * noticing.
 *
 * Every process here is `process.execPath` — the Node binary already running
 * these tests — so nothing depends on a toolchain the machine might not have.
 */
import { describe, expect, it } from "vitest";

import { createNodeProcessRunner } from "../src/process-runner.js";
import { NetlifyProviderError } from "../src/provider-errors.js";

const runner = createNodeProcessRunner();

const OPTIONS = {
	cwd: process.cwd(),
	env: {},
	timeoutMs: 20_000,
	maxOutputBytes: 64 * 1024,
};

/** Run `node -e <script>` through the runner under test. */
function runScript(script: string, overrides: Partial<typeof OPTIONS> = {}) {
	return runner.run([process.execPath, "-e", script], {
		...OPTIONS,
		...overrides,
	});
}

describe("argv handling", () => {
	it("refuses an empty argv rather than spawning something arbitrary", async () => {
		// `spawn(undefined, …)` would throw from deep inside child_process with a
		// message that says nothing about which caller built the argv.
		await expect(runner.run([], OPTIONS)).rejects.toThrow(
			/argv must name a program to run/u,
		);
		try {
			await runner.run([], OPTIONS);
		} catch (error) {
			expect(error).toMatchObject({ code: "PROVIDER_CONTRACT_CHANGED" });
		}
	});

	it("splits the argv into a file and its arguments", async () => {
		const result = await runner.run(
			[
				process.execPath,
				"-e",
				"process.stdout.write(process.argv.length + '')",
			],
			OPTIONS,
		);
		expect(result.code).toBe(0);
		// `node -e` leaves argv as [execPath] only, which is what proves the
		// script text was passed as an argument rather than concatenated in.
		expect(result.stdout).toBe("1");
	});
});

describe("no shell is involved", () => {
	it("passes a semicolon through as data, not as a command separator", async () => {
		// The injection case. Under `shell: true` this argument would terminate
		// the command and run `echo pwned` as a second one.
		const result = await runner.run(
			[
				process.execPath,
				"-e",
				"process.stdout.write(process.argv[1] ?? '')",
				"; echo pwned",
			],
			OPTIONS,
		);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("; echo pwned");
		expect(result.stdout).not.toBe("");
	});

	it("passes command substitution through as data", async () => {
		// `$(id)` and backticks are the other two shapes a shell would expand.
		// Each must arrive at the program verbatim.
		for (const hostile of ["$(id)", "`id`", "&& rm -rf /", "| tee /tmp/x"]) {
			const result = await runner.run(
				[
					process.execPath,
					"-e",
					"process.stdout.write(process.argv[1] ?? '')",
					hostile,
				],
				OPTIONS,
			);
			expect(result.stdout).toBe(hostile);
		}
	});

	it("passes a glob through unexpanded", async () => {
		// A shell would expand `*` against the working directory, turning one
		// argument into however many files happen to be there.
		const result = await runner.run(
			[
				process.execPath,
				"-e",
				"process.stdout.write(String(process.argv.length - 1))",
				"*",
			],
			OPTIONS,
		);
		expect(result.stdout).toBe("1");
	});
});

describe("output capture", () => {
	it("returns stdout, stderr and the exit code separately", async () => {
		// Separately, because the deploy-output parser reads stdout while an
		// operator reads stderr. Merging them would put progress chatter into
		// the machine-read stream.
		const result = await runScript(
			"process.stdout.write('out');process.stderr.write('err');process.exit(0)",
		);
		expect(result.stdout).toBe("out");
		expect(result.stderr).toBe("err");
		expect(result.code).toBe(0);
	});

	it("reports a non-zero exit code rather than throwing", async () => {
		// A failing CLI is a result the caller interprets, not an exception. The
		// caller knows which exit codes mean "already exists" versus "denied".
		const result = await runScript("process.exit(3)");
		expect(result.code).toBe(3);
	});

	it("accumulates output arriving in several chunks", async () => {
		// Streams arrive in arbitrary chunk sizes; a capture that replaced rather
		// than appended would silently keep only the last write.
		const result = await runScript(
			"for (let i = 0; i < 50; i++) process.stdout.write('x');",
		);
		expect(result.stdout).toBe("x".repeat(50));
	});

	it("rejects rather than returning truncated output", async () => {
		// The important direction. Returning what fit would hand the deploy-output
		// parser a partial log, and a claim URL cut in half is worse than no log
		// at all — the parser would find a URL-shaped string and act on it.
		await expect(
			runScript("process.stdout.write('x'.repeat(5000))", {
				maxOutputBytes: 100,
			}),
		).rejects.toThrow(/more than 100 bytes of output/u);
	});

	it("applies the cap to stderr as well as stdout", async () => {
		// Both streams are held in memory, so capping only one would leave the
		// other unbounded.
		await expect(
			runScript("process.stderr.write('x'.repeat(5000))", {
				maxOutputBytes: 100,
			}),
		).rejects.toThrow(/more than 100 bytes of output/u);
	});

	it("allows output up to the cap", async () => {
		const result = await runScript("process.stdout.write('x'.repeat(50))", {
			maxOutputBytes: 100,
		});
		expect(result.stdout).toBe("x".repeat(50));
	});

	it("reports output truncation as an ambiguous external outcome", async () => {
		try {
			await runScript("process.stdout.write('x'.repeat(5000))", {
				maxOutputBytes: 10,
			});
			expect.unreachable("oversized output must be refused");
		} catch (error) {
			expect(error).toBeInstanceOf(NetlifyProviderError);
			expect(error).toMatchObject({ code: "PROVIDER_OPERATION_AMBIGUOUS" });
		}
	});
});

describe("failure to start", () => {
	it("reports a missing program with the CLI package spec", async () => {
		// A spawn error is not a CLI failure — the CLI never ran. Naming the
		// package spec tells an operator what was supposed to be installed,
		// which is the actionable part of an ENOENT.
		try {
			await runner.run(
				["definitely-not-a-real-program-hobo-test", "--version"],
				OPTIONS,
			);
			expect.unreachable("a missing program must be reported");
		} catch (error) {
			expect(error).toBeInstanceOf(NetlifyProviderError);
			expect(error).toMatchObject({ code: "PROVIDER_CONTRACT_CHANGED" });
			expect(error).toHaveProperty(
				"message",
				expect.stringContaining("could not be started"),
			);
			expect(error).toHaveProperty("cause");
		}
	});
});

describe("environment", () => {
	it("passes only the environment it was given", async () => {
		// `env: { ...options.env }` replaces rather than extends `process.env`.
		// That is what keeps an ambient `NETLIFY_AUTH_TOKEN` in a developer's
		// shell out of a run that is supposed to be anonymous.
		const result = await runner.run(
			[
				process.execPath,
				"-e",
				"process.stdout.write(process.env.HOBO_PROBE ?? 'unset')",
			],
			{ ...OPTIONS, env: { HOBO_PROBE: "given" } },
		);
		expect(result.stdout).toBe("given");
	});

	it("does not inherit an ambient variable the caller did not pass", async () => {
		// The half that matters for the anonymous path: a token in the parent
		// environment must not reach the child.
		const saved = process.env.HOBO_AMBIENT_PROBE;
		process.env.HOBO_AMBIENT_PROBE = "leaked";
		try {
			const result = await runner.run(
				[
					process.execPath,
					"-e",
					"process.stdout.write(process.env.HOBO_AMBIENT_PROBE ?? 'unset')",
				],
				{ ...OPTIONS, env: {} },
			);
			expect(result.stdout).toBe("unset");
		} finally {
			if (saved === undefined) delete process.env.HOBO_AMBIENT_PROBE;
			else process.env.HOBO_AMBIENT_PROBE = saved;
		}
	});

	it("copies the env rather than handing over the caller's object", async () => {
		// A spread, so a runtime that mutated the object it was given could not
		// write back into the caller's record.
		const env = { HOBO_PROBE: "given" };
		await runner.run([process.execPath, "-e", ""], { ...OPTIONS, env });
		expect(env).toEqual({ HOBO_PROBE: "given" });
	});
});

describe("timeout", () => {
	it("kills a process that outruns its budget", async () => {
		// SIGKILL rather than SIGTERM: the CLI is a third-party program that may
		// ignore a polite signal, and a deploy step that hung forever would take
		// the whole run with it. The killed process still resolves with a result
		// — a non-zero/`null` code — rather than hanging.
		const result = await runScript("setTimeout(() => {}, 60000)", {
			timeoutMs: 200,
		});
		expect(result.code).not.toBe(0);
	});

	it("clears the timer on a normal exit", async () => {
		// If the timer were left armed, a short run would keep the event loop
		// alive for the full timeout and every test after it would drag.
		const started = Date.now();
		await runScript("process.exit(0)", { timeoutMs: 30_000 });
		expect(Date.now() - started).toBeLessThan(20_000);
	});
});
