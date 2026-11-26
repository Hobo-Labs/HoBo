import { describe, expect, it } from "vitest";

import { outcomeError, parseOutcome } from "../src/outcome.js";
import {
	SAMPLE_LINES,
	type SampleScenario,
} from "./fixtures/opensesame-lines.js";

const stderrOf = (scenario: SampleScenario) =>
	`${SAMPLE_LINES[scenario].join("\n")}\n`;

/** Everything OpenSesame can say about the `node` it runs the env-spec bridge with, old words and new. */
const NODE_REFUSALS = [
	"bridge-no-node",
	"bridge-untrusted-node",
	"bridge-node-elsewhere",
	"bridge-no-usable-node",
	"bridge-no-usable-node-elsewhere",
	"bridge-no-usable-node-rejected",
	"bridge-node-override-empty",
	"bridge-node-override-relative",
	"bridge-node-override-missing",
	"bridge-node-override-not-file",
	"bridge-node-override-not-executable",
] as const;

describe("a node OpenSesame cannot use is bridge_missing, whichever words it says it in", () => {
	for (const scenario of NODE_REFUSALS) {
		it(`${scenario}: bridge_missing, status 1`, () => {
			const outcome = parseOutcome(1, null, stderrOf(scenario));
			expect(outcome, scenario).toMatchObject({
				kind: "bridge_missing",
				exitCode: 1,
			});
			expect(outcomeError(outcome)?.code, scenario).toBe("bridge_missing");
		});
	}

	it("a bad OPENSESAME_NODE is not 'OpenSesame refused the generated .env.schema'", () => {
		const outcome = parseOutcome(
			1,
			null,
			stderrOf("bridge-node-override-relative"),
		);
		expect(outcome.kind).not.toBe("schema_refused");
		expect(outcomeError(outcome)?.code).not.toBe("launch_invalid");
	});

	it("the advice names the override and the passEnv route, not only the PATH directory", () => {
		for (const scenario of NODE_REFUSALS) {
			const message = outcomeError(
				parseOutcome(1, null, stderrOf(scenario)),
			)?.message;
			expect(message, scenario).toContain("OPENSESAME_NODE");
			expect(message, scenario).toContain("passEnv");
			expect(message, scenario).toContain("PATH");
		}
	});

	it("still needs the failing status and the words at the start of OpenSesame's error", () => {
		expect(
			parseOutcome(0, null, stderrOf("bridge-node-override-missing")),
		).toMatchObject({ kind: "child_exit", exitCode: 0 });
		// A schema error that happens to mention the variable, or a child's text, is not the override refusal.
		for (const text of [
			"Error: env-spec parse failed: bridge failed: SyntaxError near OPENSESAME_NODE does not exist\n",
			"Error: resolve failed: OPENSESAME_NODE does not exist: x\n",
			"the child said Error: env-spec parse failed: OPENSESAME_NODE does not exist\n",
		]) {
			expect(parseOutcome(1, null, text).kind, text).not.toBe("bridge_missing");
		}
	});
});
