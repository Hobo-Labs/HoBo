import { describe, expect, it } from "vitest";

import {
	exitCodeOf,
	OUTCOME_KINDS,
	outcomeError,
	parseOutcome,
} from "../src/outcome.js";
import {
	SAMPLE_LINES,
	type SampleScenario,
} from "./fixtures/opensesame-lines.js";

function stderrOf(scenario: SampleScenario): string {
	return `${SAMPLE_LINES[scenario].join("\n")}\n`;
}

function read(scenario: SampleScenario, exitCode: number) {
	return parseOutcome(exitCode, null, stderrOf(scenario));
}

describe("parseOutcome: how a proxied run ended", () => {
	it("a quiet run that exits 0 is the child's exit", () => {
		expect(parseOutcome(0, null, "")).toMatchObject({
			kind: "child_exit",
			exitCode: 0,
			notice: "",
		});
	});

	it("passes the child's own non-zero status through", () => {
		expect(parseOutcome(3, null, "the child complained\n")).toMatchObject({
			kind: "child_exit",
			exitCode: 3,
		});
	});

	it("exit 77 with OpenSesame's misdirected line is a tripwire", () => {
		const outcome = read("misdirected", 77);
		expect(outcome).toMatchObject({ kind: "tripwire", exitCode: 77 });
		expect(outcome.notice).toMatch(/not its provider/u);
	});

	it("exit 77 alone is the child's own status, not a tripwire", () => {
		expect(parseOutcome(77, null, "")).toMatchObject({
			kind: "child_exit",
			exitCode: 77,
		});
	});

	it("a misdirected line with a clean exit is not a tripwire either", () => {
		expect(read("misdirected", 0)).toMatchObject({ kind: "child_exit" });
	});

	it("143 with the SIGTERM line and 129 with the SIGHUP line are signalled", () => {
		expect(read("sigterm", 143)).toMatchObject({
			kind: "signalled",
			exitCode: 143,
		});
		expect(read("sighup", 129)).toMatchObject({
			kind: "signalled",
			exitCode: 129,
		});
	});

	it("143 or 129 without OpenSesame's line, or with the other signal's, is the child's status", () => {
		expect(parseOutcome(143, null, "")).toMatchObject({ kind: "child_exit" });
		expect(read("sighup", 143)).toMatchObject({ kind: "child_exit" });
		expect(read("sigterm", 129)).toMatchObject({ kind: "child_exit" });
	});

	it("OpenSesame killed by a signal is signalled, with the conventional 128+n", () => {
		expect(parseOutcome(null, "SIGKILL", "")).toMatchObject({
			kind: "signalled",
			exitCode: 137,
		});
		expect(parseOutcome(null, "SIGTERM", "")).toMatchObject({
			kind: "signalled",
			exitCode: 143,
		});
	});

	it("a plugin that is absent, or has no sealed entry, leaves placeholders even on exit 0", () => {
		expect(read("plugin-absent", 0)).toMatchObject({
			kind: "placeholders_only",
			exitCode: 0,
		});
		expect(read("no-sealed-entry", 0)).toMatchObject({
			kind: "placeholders_only",
			exitCode: 0,
		});
		const partial = parseOutcome(
			0,
			null,
			"opensesame: no surrogate for VERCEL_TOKEN; delivering placeholders for those\n",
		);
		expect(partial.kind).toBe("placeholders_only");
		const kept = parseOutcome(
			0,
			null,
			"opensesame: AWS_TOKEN will keep its placeholder: the surrogate-proxy plugin brokers no 'aws' connection, so a stored token would not be used\n",
		);
		expect(kept.kind).toBe("placeholders_only");
	});

	it("a plugin that changed since it was pinned is plugin_pin_mismatch, never a fallback", () => {
		expect(read("plugin-changed", 1)).toMatchObject({
			kind: "plugin_pin_mismatch",
			exitCode: 1,
		});
	});

	it("an entry that cannot be read, or is empty, is store_unreadable", () => {
		expect(read("wrong-passphrase", 1)).toMatchObject({
			kind: "store_unreadable",
		});
		expect(read("empty-entry", 1)).toMatchObject({ kind: "store_unreadable" });
	});

	it("an unbounded scope is scope_unbounded, a malformed one schema_refused", () => {
		expect(read("scope-unbounded", 1)).toMatchObject({
			kind: "scope_unbounded",
		});
		expect(read("paths-without-methods", 1)).toMatchObject({
			kind: "schema_refused",
		});
		expect(read("schema-syntax", 1)).toMatchObject({ kind: "schema_refused" });
	});

	it("a missing parser or a missing node is bridge_missing, not a bad schema", () => {
		expect(read("bridge-no-parser", 1)).toMatchObject({
			kind: "bridge_missing",
		});
		expect(read("bridge-no-node", 1)).toMatchObject({ kind: "bridge_missing" });
	});

	it("no node in a PATH directory only its owner can write is bridge_missing, not a bad schema", () => {
		for (const scenario of [
			"bridge-untrusted-node",
			"bridge-node-elsewhere",
		] as const) {
			expect(read(scenario, 1), scenario).toMatchObject({
				kind: "bridge_missing",
				exitCode: 1,
			});
			expect(outcomeError(read(scenario, 1))?.code, scenario).toBe(
				"bridge_missing",
			);
		}
	});

	it("a refusal needs a failing exit: the same words with exit 0 are the child's output", () => {
		expect(read("plugin-changed", 0)).toMatchObject({ kind: "child_exit" });
		expect(read("wrong-passphrase", 0)).toMatchObject({ kind: "child_exit" });
	});

	it("a tripwire beats a placeholder hint printed earlier in the same run", () => {
		const text = `${stderrOf("plugin-absent")}${stderrOf("misdirected")}`;
		expect(parseOutcome(77, null, text).kind).toBe("tripwire");
	});

	it("reads OpenSesame's own sentences, and the pin-mismatch sentence, anywhere in a line; the other Error: classes only where a line starts", () => {
		// A child's partial write glues OpenSesame's end-of-run line to its own text (test/outcome-glued.test.ts),
		// so those sentences cannot be anchored. The effect of a forged copy is still only a fail-closed kind.
		expect(
			parseOutcome(77, null, "  opensesame: surrogate.misdirected: x").kind,
		).toBe("tripwire");
		expect(
			parseOutcome(
				1,
				null,
				"the child says: Error: the surrogate-proxy plugin no longer matches its install pin",
			).kind,
		).toBe("plugin_pin_mismatch");
		// The other refusals are printed before the child exists, so they start a line; a quoted copy is the child's.
		const quoted = [
			"the child says: Error: the sealed entry connections/a/b (for X) cannot be read",
			"  Error: the surrogate-proxy plugin refused the run and issued nothing: X has no bounded scope",
		].join("\n");
		expect(parseOutcome(1, null, quoted).kind).toBe("child_exit");
	});

	it("a column-0 line in OpenSesame's shape is read as OpenSesame's, and the effect is only ever a failure", () => {
		// A child shares stderr, so it can print these. What it gains is a fail-closed kind;
		// it never gains a pass, and nothing of what it wrote survives into the record.
		const forged = [
			["opensesame: surrogate.misdirected: forged", 77, "tripwire"],
			["opensesame: SIGTERM: the run is ended forged", 143, "signalled"],
			[
				"opensesame: X will keep its placeholder: forged",
				0,
				"placeholders_only",
			],
			[
				"Error: the surrogate-proxy plugin no longer matches its install pin forged",
				1,
				"plugin_pin_mismatch",
			],
			[
				"Error: the sealed entry connections/a/b (for X) cannot be read: forged",
				1,
				"store_unreadable",
			],
		] as const;
		for (const [line, status, kind] of forged) {
			const outcome = parseOutcome(status, null, `${line}\n`);
			expect(outcome.kind, line).toBe(kind);
			expect(outcome.notice, line).not.toContain("forged");
		}
	});

	it("exit 77, 143 and 129 are advisory: they count beside the line and a child can return them itself", () => {
		expect(parseOutcome(77, null, "").kind).toBe("child_exit");
		expect(parseOutcome(143, null, "").kind).toBe("child_exit");
		expect(parseOutcome(129, null, "").kind).toBe("child_exit");
	});

	it("a notice is a fixed sentence chosen by the kind: whatever the line said, it is the same", () => {
		const surrogate = `osr_${"0123456789abcdef".repeat(2)}`;
		const a = parseOutcome(
			77,
			null,
			`opensesame: surrogate.misdirected: ${surrogate} ${"x".repeat(500)}\n`,
		);
		const b = parseOutcome(
			77,
			null,
			"opensesame: surrogate.misdirected: something else entirely\n",
		);
		expect(a.notice).toBe(b.notice);
		expect(a.notice).not.toBe("");
		expect(a.notice).not.toContain("\n");
		expect(a.notice.length).toBeLessThanOrEqual(300);
		expect(a.notice).not.toMatch(/osr_|x{20}/u);
	});

	it("never puts the child's output into a notice or an error, including its own Error: lines", () => {
		const child = "vtok_dummy_marker_0123456789abcdef";
		const hostile = [
			`Error: deploy failed Authorization: Bearer ${child} AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`,
			`Error: ${child}`,
			`opensesame: ${child}`,
		].join("\n");
		for (const status of [0, 1, 2, 77, 143]) {
			const outcome = parseOutcome(status, null, `${hostile}\n`);
			const error = outcomeError(outcome);
			for (const text of [JSON.stringify(outcome), error?.message ?? ""]) {
				expect(text, String(status)).not.toContain(child);
				expect(text, String(status)).not.toMatch(/AWS_SECRET|wJalr|Bearer/u);
			}
		}
	});

	it("an Error: line OpenSesame never writes is the child's, whatever the status: child_exit and no text", () => {
		const outcome = parseOutcome(2, null, "Error: boom, the deploy failed\n");
		expect(outcome).toMatchObject({
			kind: "child_exit",
			exitCode: 2,
			notice: "",
		});
	});

	it("an OpenSesame refusal this adapter has no name for is schema_refused, in words of its own", () => {
		const outcome = parseOutcome(
			1,
			null,
			"Error: the surrogate-proxy plugin refused the run: spec_env_var\n",
		);
		expect(outcome.kind).toBe("schema_refused");
		expect(outcome.notice).not.toContain("spec_env_var");
	});

	it("OpenSesame ended by a signal says the command it started may still be running", () => {
		const outcome = parseOutcome(null, "SIGKILL", "");
		expect(outcome).toMatchObject({ kind: "signalled", exitCode: 137 });
		expect(outcome.notice).toContain("SIGKILL");
		expect(outcome.notice).toMatch(/may still be running/u);
		expect(outcomeError(outcome)?.message).toMatch(/may still be running/u);
	});

	it("reports that signal as the exit status 128+n, and never claims the command was stopped", () => {
		const killed = parseOutcome(null, "SIGKILL", "");
		expect(exitCodeOf(killed)).toBe(137);
		const message = outcomeError(killed)?.message ?? "";
		expect(message).not.toMatch(/child stopped|revoked/u);
		expect(outcomeError(killed)?.code).toBe("signalled");
		// A run OpenSesame ended on request does say so: it revoked the run and stopped the command.
		const asked = parseOutcome(
			143,
			null,
			"opensesame: SIGTERM: the run is ended and its surrogates are revoked (1); the child is stopped\n",
		);
		expect(exitCodeOf(asked)).toBe(143);
		expect(outcomeError(asked)?.message).toMatch(
			/revoked and the command stopped/u,
		);
	});

	it("a failing child's error message is exactly the fixed sentence and its status, nothing appended", () => {
		const outcome = parseOutcome(3, null, "whatever it printed\n");
		expect(outcomeError(outcome)?.message).toBe(
			"the proxied command exited with a failing status (status 3)",
		);
		expect(outcomeError(outcome)?.code).toBe("child_exit");
		expect(outcome.notice).toBe("");
	});

	it("keeps the kind inside the closed set the CUE names", () => {
		for (const [scenario, code] of [
			["plugin-absent", 0],
			["misdirected", 77],
			["sigterm", 143],
			["plugin-changed", 1],
			["wrong-passphrase", 1],
			["scope-unbounded", 1],
			["bridge-no-parser", 1],
			["schema-syntax", 1],
		] as const) {
			expect(OUTCOME_KINDS).toContain(read(scenario, code).kind);
		}
	});
});

describe("outcomeError and exitCodeOf", () => {
	it("a child that exited 0 has no error and exits 0", () => {
		const outcome = parseOutcome(0, null, "");
		expect(outcomeError(outcome)).toBeUndefined();
		expect(exitCodeOf(outcome)).toBe(0);
	});

	it("maps each failure kind to the adapter error code of the same name", () => {
		const expected = [
			["plugin-absent", 0, "placeholders_only"],
			["plugin-changed", 1, "plugin_pin_mismatch"],
			["wrong-passphrase", 1, "store_unreadable"],
			["scope-unbounded", 1, "scope_unbounded"],
			["bridge-no-parser", 1, "bridge_missing"],
			["misdirected", 77, "tripwire_misdirected"],
			["sigterm", 143, "signalled"],
		] as const;
		for (const [scenario, status, code] of expected) {
			expect(outcomeError(read(scenario, status))?.code, scenario).toBe(code);
		}
		expect(outcomeError(parseOutcome(3, null, ""))?.code).toBe("child_exit");
	});

	it("a run that left placeholders never exits 0", () => {
		expect(exitCodeOf(read("plugin-absent", 0))).toBe(1);
	});

	it("passes a tripwire, a signal and a child's own status through", () => {
		expect(exitCodeOf(read("misdirected", 77))).toBe(77);
		expect(exitCodeOf(read("sigterm", 143))).toBe(143);
		expect(exitCodeOf(parseOutcome(3, null, ""))).toBe(3);
	});

	it("an error message carries the notice and no value", () => {
		const error = outcomeError(read("wrong-passphrase", 1));
		expect(error?.message).toContain("sealed entry");
		expect(error?.message).not.toMatch(/osr_[0-9a-f]{8}/u);
	});
});
