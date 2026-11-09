/**
 * The deep tier of `LONG_TOKEN_RUN_PROFILE` (`pnpm run test:deep`): its
 * differential against the rule it replaced at 50k texts on three seeds, its
 * growth on the hostile inputs its fallback meets, and its sweep. Once, for the
 * six providers that share it.
 */
import {
	asGlobal,
	assertPatternSweepLinear,
	type PatternSearch,
	profilePatterns,
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
	createProviderRedactor,
	KEPT_LOCATOR,
	LONG_TOKEN_RUN_PROFILE,
	redactionPattern,
	redactMatches,
} from "../src/provider-redaction.js";
import { redactLongTokens } from "./fixtures/long-token-base.js";

const redact = createProviderRedactor(LONG_TOKEN_RUN_PROFILE);
const LONG = 1_000_000;

/** A pattern searched the way `redactMatches` searches it, made global. */
const searchShape: PatternSearch = (text, pattern) => {
	redactMatches(text, [redactionPattern(asGlobal(pattern))]);
};

describe("the long-token profile, deep", () => {
	it.each(DEEP_SEEDS)("hides every marker the rule it replaced hid (seed %i)", {
		timeout: 600_000,
	}, (seed) => {
		const hidden = assertRevealsNoMore(
			(text) => redactLongTokens(text, LONG),
			(text) => redact(text, LONG),
			{ count: 50_000, seed, kept: KEPT_LOCATOR },
		);
		expect(hidden).toBeGreaterThan(1000);
	});

	// The fallback meets the key and JWT code: a long run over a key's END
	// line, a run of `-ey`, short runs a long-run rule reads and gives back.
	it.each([
		["-ey", repeatedTo("-ey")],
		["BEGIN markers", repeatedTo("-----BEGIN PRIVATE KEY-----")],
		["short runs", repeatedTo("a.")],
	] as const)(
		"redacting %s grows linearly",
		{ timeout: 600_000 },
		(_case, input) => {
			assertGrowsLinearly((text) => {
				redact(text, 8 * LONG);
			}, input);
		},
	);

	it.each(
		profilePatterns(LONG_TOKEN_RUN_PROFILE).map(
			(pattern) => [pattern.source, pattern] as const,
		),
	)(
		"its pattern /%s/ grows linearly on the whole sweep",
		{ timeout: 600_000 },
		(_source, pattern) => {
			assertPatternSweepLinear(pattern, searchShape);
		},
	);
});
