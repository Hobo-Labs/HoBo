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
} from "@hobo/provider-redaction";
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

import { redactProviderText } from "../src/index.js";
import { VERCEL_REDACTION_PROFILE } from "../src/provider-errors.js";
import { redactProviderText as baseRedact } from "./fixtures/base-redaction.js";
import { redactProviderText as mainRedact } from "./fixtures/main-redaction.js";

/** A pattern searched the way `redactMatches` searches it, made global. */
const searchShape: PatternSearch = (text, pattern) => {
	redactMatches(text, [redactionPattern(asGlobal(pattern))]);
};

const MB = 1_000_000;

describe("provider-vercel redaction", () => {
	it.each([["near-miss transfer codes", repeatedTo("code=ABC ")]] as const)(
		"redacting %s grows linearly",
		{ timeout: 600_000 },
		(_case, input) => {
			assertGrowsLinearly((text) => {
				redactProviderText(text, 8 * MB);
			}, input);
		},
	);
});

// Against the redactor this caller had before (vendored under test/fixtures):
// on generated texts full of credential shapes, separators and control
// characters, every marker half the old one hid stays hidden, and every
// pattern this caller adds is linear on every class and pair of classes.
describe("against the redactor it replaced", () => {
	const LONG = 1_000_000;
	it.each(
		DEEP_SEEDS,
	)("hides every marker the base branch's redactor hid (seed %i)", {
		timeout: 600_000,
	}, (seed) => {
		const hidden = assertRevealsNoMore(
			(text) => baseRedact(text, LONG),
			(text) => redactProviderText(text, LONG),
			{ count: 50_000, seed, kept: KEPT_LOCATOR },
		);
		expect(hidden).toBeGreaterThan(1000);
	});
	it.each(DEEP_SEEDS)("hides every marker main's redactor hid (seed %i)", {
		timeout: 600_000,
	}, (seed) => {
		const hidden = assertRevealsNoMore(
			(text) => mainRedact(text, LONG),
			(text) => redactProviderText(text, LONG),
			{ count: 50_000, seed, kept: KEPT_LOCATOR },
		);
		expect(hidden).toBeGreaterThan(1000);
	});
	it.each(
		profilePatterns(VERCEL_REDACTION_PROFILE).map(
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
