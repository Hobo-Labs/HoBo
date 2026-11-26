import assert from "node:assert/strict";
import { test } from "vitest";
import { selectRelevantChecks } from "../scripts/relevant-check-policy.js";

function commands(files: string[]): string[] {
	return selectRelevantChecks({ files, base: "origin/main" }).checks.map(
		(check) => `${check.command} ${check.args.join(" ")}`,
	);
}

for (const file of [
	".optimizexp/personas/jony-ive.md",
	".optimizexp/bus/entries/council-position.json",
	".optimizexp/runs/run-1/consensus/review-1/state.json",
	".agents/skills/optimizexp/harness/lib/design-council.mts",
	".claude/skills/optimizexp/workflows/cross-agent/consensus-loop.mts",
	".agents/skills/sdlc/SKILL.md",
	".claude/skills/sdlc/references/finish.md",
	".optimizexp/features/designer-council-consensus/designer-council-consensus-jony-ive.feature",
]) {
	test(`${file} selects the OptimizeXP consensus gate`, () => {
		assert.ok(commands([file]).includes("pnpm run optimizexp:check"), file);
	});
}
