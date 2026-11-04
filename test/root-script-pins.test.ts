/**
 * The root package.json scripts the relevant-check policy and the gates it
 * selects depend on by name, pinned to the commands they run.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

test("fast test script is root-only and full quiet unit lane remains explicit", () => {
	// SAFETY: package.json is a committed repo file; scripts values are strings.
	const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
		scripts: Record<string, string>;
	};

	assert.equal(
		packageJson.scripts["test:fast"],
		"node --import tsx scripts/run-tests.ts --root-only --quiet --no-artifacts",
	);
	assert.equal(
		packageJson.scripts["test:unit:quiet"],
		"node --import tsx scripts/run-unit-tests.ts --quiet",
	);
	// The whole-repository lane denies warnings, as the changed-file lane
	// does (5ff4548a); the bare `oxlint` this pinned let warnings through.
	assert.equal(
		packageJson.scripts["lint:slop"],
		"oxlint --deny-warnings --no-error-on-unmatched-pattern .",
	);
	assert.equal(
		packageJson.scripts["lint:slop:changed"],
		"node --import tsx scripts/lint-slop-changed.mts",
	);
	assert.equal(
		packageJson.scripts["typecheck"],
		'turbo run typecheck --filter "./packages/*" --filter @hobo/draft-connectivity-tier-ir-contract --concurrency=100%',
	);
});
