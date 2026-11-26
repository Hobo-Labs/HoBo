/**
 * The deep tier of this package's redaction tests (`pnpm run test:deep`): the
 * differential against what it replaced at full size, every pattern it adds
 * swept, and growth measured on hostile text. The fast tier is
 * `privacy-linear.test.ts`.
 */

import {
	KEPT_LOCATOR,
	redactionPattern,
	redactMatches,
	SHARED_PATTERNS,
} from "@hobo/provider-redaction";
import {
	asGlobal,
	assertPatternSweepLinear,
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

import { redactDebugPayload } from "../src/index.js";
import { SECRET_STRING, SENSITIVE_DEBUG_KEY } from "../src/privacy.js";
import { redactDebugPayload as baseRedactDebugPayload } from "./fixtures/base-redaction.js";

/** A pattern searched the way `redactMatches` searches it. */
const searchAsRedactor: PatternSearch = (text, pattern) => {
	redactMatches(text, [redactionPattern(asGlobal(pattern))]);
};

const MASK = "••••";
const masked = (value: string): boolean =>
	redactDebugPayload({ value }).value === MASK;

describe("the debug-payload secret pattern", () => {
	it.each([
		["eyJ over and over", repeatedTo("eyJ")],
		["letters", repeatedTo("a")],
		["a scheme run", repeatedTo("a.")],
		["key names with no =", repeatedTo("TOKEN")],
	] as const)(
		"testing %s grows linearly",
		{ timeout: 600_000 },
		(_case, input) => {
			assertGrowsLinearly((text) => {
				masked(text);
			}, input);
		},
	);
});

// Against the masking as it stood before (vendored under test/fixtures): on
// generated texts full of credential shapes and control characters, every
// string the old one masked is masked; and the check is linear on runs of
// every character class and pair of them.
describe("redactDebugPayload against the masking it replaced", () => {
	const shown =
		(redact: typeof redactDebugPayload) =>
		(text: string): string =>
			JSON.stringify(redact({ message: text }));
	it.each(DEEP_SEEDS)("masks every string the old masking masked (seed %i)", {
		timeout: 600_000,
	}, (seed) => {
		expect(
			assertRevealsNoMore(
				shown(baseRedactDebugPayload),
				shown(redactDebugPayload),
				{ count: 50_000, seed, kept: KEPT_LOCATOR },
			),
		).toBeGreaterThan(1000);
	});
});

// Each of the debug-payload patterns, on runs of every class and between its own
// fragments (`patternFragments`), but those core shares, which core sweeps.
describe("each pattern on the whole sweep", () => {
	it.each(
		ownPatterns([SECRET_STRING, SENSITIVE_DEBUG_KEY], SHARED_PATTERNS).map(
			(pattern) => [pattern.source, pattern] as const,
		),
	)("/%s/ grows linearly", { timeout: 600_000 }, (_source, pattern) => {
		assertPatternSweepLinear(pattern, searchAsRedactor);
	});
});
