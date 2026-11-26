import { describe, expect, it } from "vitest";

import { exitCodeOf, outcomeError, parseOutcome } from "../src/outcome.js";
import {
	SAMPLE_LINES,
	type SampleScenario,
} from "./fixtures/opensesame-lines.js";

const DUMMY = "vtok_dummy_marker_0123456789abcdef";

function line(scenario: SampleScenario): string {
	return SAMPLE_LINES[scenario].join("\n");
}

/**
 * OpenSesame writes its end-of-run line with eprintln! after it has stopped the
 * child, with no newline before it. A child whose last write had none (a
 * partial write, a spinner ending on a carriage return) leaves that line glued to
 * its own text, so it is not at the start of a line.
 */
const GLUES: readonly [string, string][] = [
	["a partial write", "partial"],
	["a spinner ending on a carriage return", "Working... 40%\r"],
	["several carriage-return frames", "|\r/\r-\r\\\r"],
	["a carriage-return frame then a partial word", "Working...\rdon"],
	[
		"a partial write holding a credential shape",
		`Authorization: Bearer ${DUMMY}`,
	],
	["a partial write that begins like OpenSesame's prefix", "opensesame:"],
	["a lot of text", "x".repeat(70_000)],
];

describe("OpenSesame's tripwire, signal and refusal lines are read where a child's partial write has glued them on", () => {
	for (const [label, glue] of GLUES) {
		it(`exit 77 is a tripwire after ${label}`, () => {
			const outcome = parseOutcome(77, null, `${glue}${line("misdirected")}\n`);
			expect(outcome).toMatchObject({ kind: "tripwire", exitCode: 77 });
			expect(outcomeError(outcome)?.code).toBe("tripwire_misdirected");
			expect(JSON.stringify(outcome)).not.toContain(DUMMY);
			expect(outcomeError(outcome)?.message ?? "").not.toContain(DUMMY);
		});

		it(`143 and 129 are signalled after ${label}`, () => {
			expect(
				parseOutcome(143, null, `${glue}${line("sigterm")}\n`),
			).toMatchObject({ kind: "signalled", exitCode: 143 });
			expect(
				parseOutcome(129, null, `${glue}${line("sighup")}\n`),
			).toMatchObject({ kind: "signalled", exitCode: 129 });
		});
	}

	it("a placeholder line and a pin-mismatch line are read the same way", () => {
		expect(
			parseOutcome(0, null, `partial${line("plugin-absent")}\n`),
		).toMatchObject({ kind: "placeholders_only" });
		expect(
			parseOutcome(1, null, `partial${line("plugin-changed")}\n`),
		).toMatchObject({ kind: "plugin_pin_mismatch" });
		expect(
			parseOutcome(1, null, `\rspinner\r${line("plugin-changed")}\n`),
		).toMatchObject({ kind: "plugin_pin_mismatch" });
	});

	it("a line ended by a carriage return alone is a line", () => {
		expect(parseOutcome(77, null, `${line("misdirected")}\r`)).toMatchObject({
			kind: "tripwire",
		});
		expect(
			parseOutcome(77, null, `a\r\n${line("misdirected")}\r\nb`),
		).toMatchObject({ kind: "tripwire" });
	});

	it("is still only a fail-closed kind: the status has to agree, and no pass comes of it", () => {
		expect(parseOutcome(0, null, `x${line("misdirected")}\n`)).toMatchObject({
			kind: "child_exit",
		});
		expect(parseOutcome(143, null, `x${line("sighup")}\n`)).toMatchObject({
			kind: "child_exit",
		});
		expect(parseOutcome(1, null, `x${line("sigterm")}\n`)).toMatchObject({
			kind: "child_exit",
		});
		expect(
			exitCodeOf(parseOutcome(0, null, `x${line("plugin-absent")}\n`)),
		).toBe(1);
	});

	it("does not take long to read, however the prefix is repeated", () => {
		// CPU time, not the clock: a loaded machine that does not run this process for a while has not made the read slower.
		// What keeps the work linear is pinned by its length in sentences.test.ts; this is the end-to-end smoke.
		const hostile = "opensesame: ".repeat(10_000);
		for (const status of [0, 1, 77, 129, 143]) {
			const before = process.cpuUsage();
			parseOutcome(status, null, `${hostile}\n${hostile}`);
			const spent = process.cpuUsage(before);
			expect(
				(spent.user + spent.system) / 1000,
				`status ${status}`,
			).toBeLessThan(500);
		}
	});

	it("never copies what the glued text said", () => {
		const outcome = parseOutcome(
			77,
			null,
			`Error: AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY ${DUMMY}${line("misdirected")}\n`,
		);
		expect(outcome.kind).toBe("tripwire");
		expect(JSON.stringify(outcome)).not.toMatch(/wJalr|vtok_dummy|AWS_SECRET/u);
	});
});
