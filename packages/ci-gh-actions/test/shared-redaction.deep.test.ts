/**
 * The deep tier of this package's redaction tests (`pnpm run test:deep`): the
 * differential against what it replaced at full size, every pattern it adds
 * swept, and growth measured on hostile text. The fast tier is
 * `shared-redaction.test.ts`.
 */

import {
	KEPT_LOCATOR,
	redactionPattern,
	redactMatches,
	SHARED_SHAPES,
} from "@hobo/provider-redaction";
import {
	asGlobal,
	assertPatternSweepLinear,
	assertSweepLinear,
	ownPatterns,
	type PatternSearch,
} from "@hobo/redaction-test-harness/linear-sweep";
import {
	assertGrowsLinearly,
	repeatedTo,
} from "@hobo/redaction-test-harness/linear-time";
import {
	assertRevealsNoMore,
	DEEP_SEEDS,
} from "@hobo/redaction-test-harness/redaction-differential";
import { describe, expect, it } from "vitest";
import {
	looksLikeSecret,
	OPAQUE_RUN,
	redactSecrets,
	SECRET_PATTERNS,
} from "../src/runner-integrations.js";
import { redactSecrets as baseRedactSecrets } from "./fixtures/base-redaction.js";

/** A pattern searched the way `redactMatches` searches it, made global. */
const searchShape: PatternSearch = (text, pattern) => {
	redactMatches(text, [redactionPattern(asGlobal(pattern))]);
};

describe("runner-integration secret patterns", () => {
	it.each([
		["-eyJ", repeatedTo("-eyJ")],
		["-eyJ signed and short", repeatedTo("-eyJAAAAAAAA.AAAAAAAA.")],
		["eyJ runs ending in a dot", repeatedTo("-eyJAAAAAAAA.")],
	] as const)(
		"redacting %s grows linearly",
		{ timeout: 600_000 },
		(_case, input) => {
			assertGrowsLinearly((text) => {
				redactSecrets(text);
			}, input);
			assertGrowsLinearly((text) => {
				looksLikeSecret(text);
			}, input);
		},
	);
});

// Against the redactor as it stood before (vendored under test/fixtures): on
// generated texts full of credential shapes and control characters, every
// marker half the old one hid stays hidden; and it is linear on runs of every
// character class and pair of them.
describe("redactSecrets against the redactor it replaced", () => {
	it.each(DEEP_SEEDS)("hides every marker the old redactor hid (seed %i)", {
		timeout: 600_000,
	}, (seed) => {
		expect(
			assertRevealsNoMore(
				(text) => baseRedactSecrets(text, []),
				(text) => redactSecrets(text, []),
				{ count: 50_000, seed, kept: KEPT_LOCATOR },
			),
		).toBeGreaterThan(1000);
	});

	it("grows linearly on the whole sweep", { timeout: 600_000 }, () => {
		assertSweepLinear((text) => redactSecrets(text, []), {
			alphabet: "aZ9",
			words: [
				"ghp_",
				"eyJ",
				"-----BEGIN PRIVATE KEY-----",
				"-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
				"sk_live_",
				"AKIA",
			],
			// A key, a run and an END line after it: B-1 in 0462fa6c.
			fragments: ["-----END"],
		});
	});
});

// Each of redactSecrets' patterns and its opaque-run rule, on runs of every class and between its own
// fragments (`patternFragments`), but those core shares, which core sweeps.
describe("each pattern on the whole sweep", () => {
	it.each(
		ownPatterns([...SECRET_PATTERNS, OPAQUE_RUN], SHARED_SHAPES).map(
			(pattern) => [pattern.source, pattern] as const,
		),
	)("/%s/ grows linearly", { timeout: 600_000 }, (_source, pattern) => {
		assertPatternSweepLinear(pattern, searchShape);
	});
});
