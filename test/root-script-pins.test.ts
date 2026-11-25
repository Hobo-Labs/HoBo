import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

test("fast test script is root-only and full quiet unit lane remains explicit", () => {
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
	assert.equal(
		packageJson.scripts["test:unit:shards"],
		"node --import tsx scripts/generate-unit-test-shards.ts",
	);
	assert.equal(
		packageJson.scripts["test:unit:shards:check"],
		"node --import tsx scripts/generate-unit-test-shards.ts --check",
	);
	for (let index = 0; index < 9; index += 1) {
		assert.equal(
			packageJson.scripts[`test:unit:draft:${index}`],
			`node --import tsx scripts/run-tests.ts --category=draft --quiet --final --shard=${index}/9`,
		);
	}
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
