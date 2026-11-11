import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { mainGateScope } from "../ci/affected-lanes.mts";
import { planCommands } from "../ci/dependent-tests.mts";

const workflow = readFileSync(
	join(import.meta.dirname, "..", "..", ".github/workflows/hobo-ci.yml"),
	"utf8",
);

describe("main workspace affected-only", () => {
	it("runs repo-wide workspace tests only when the gate widens", () => {
		assert.deepEqual(
			mainGateScope(["packages/core/src/x.ts"]).mode,
			"affected",
		);
		assert.deepEqual(mainGateScope(["pnpm-lock.yaml"]).mode, "repo-wide");
	});

	it("passes turbo --affected when HOBO_TURBO_USE_AFFECTED is set", () => {
		const prior = process.env.HOBO_TURBO_USE_AFFECTED;
		process.env.HOBO_TURBO_USE_AFFECTED = "1";
		try {
			const commands = planCommands(
				{ mode: "all", reason: "test" },
				[],
				"2",
				() => [],
			);
			assert.ok(commands[0]?.includes("--affected"));
		} finally {
			if (prior === undefined) delete process.env.HOBO_TURBO_USE_AFFECTED;
			else process.env.HOBO_TURBO_USE_AFFECTED = prior;
		}
	});

	it("wires TURBO_SCM_BASE and HOBO_TURBO_USE_AFFECTED on main workspace shards", () => {
		const start = workflow.indexOf("  main_workspace_tests:");
		const finish = workflow.indexOf("  main_gate_finish:", start);
		const block = workflow.slice(start, finish);
		assert.match(
			block,
			/TURBO_SCM_BASE: \$\{\{ needs\.main-gate-plan\.outputs\.main_base \}\}/u,
		);
		assert.match(block, /HOBO_TURBO_USE_AFFECTED:/u);
		assert.doesNotMatch(block, /HOBO_TURBO_CONCURRENCY: "1"/u);
	});
});
