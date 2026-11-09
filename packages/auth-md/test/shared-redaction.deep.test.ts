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
	SHARED_PATTERNS,
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

import { redactText } from "../src/index.js";
import { SECRET_KEY_PATTERN, SECRET_TEXT_PATTERNS } from "../src/redaction.js";
import { redactText as baseRedactText } from "./fixtures/base-redaction.js";

/** A pattern searched the way `redactMatches` searches it, made global. */
const searchAsRedactor: PatternSearch = (text, pattern) => {
	redactMatches(text, [redactionPattern(asGlobal(pattern))]);
};

// Built from pieces: this package's own test refuses a committed file that
// holds a private key's BEGIN line.
const KEY_LINE = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const END_LINE = ["-----END", "PRIVATE KEY-----"].join(" ");

describe("redactText", () => {
	it.each([
		["-eyJ", repeatedTo("-eyJ")],
		["BEGIN markers", repeatedTo(KEY_LINE)],
		["short runs", repeatedTo(`${"a-".repeat(19)}. `)],
		// A signature ending in `-`, which a trailing `\b` would refuse, after
		// a run of `eyJ-`: each `eyJ` started the short-JWT search again.
		[
			"eyJ- runs and a signature ending in -",
			(length: number) => `${"eyJ-".repeat(Math.ceil(length / 4))}x.aaaa.----`,
		],
	] as const)(
		"redacting %s grows linearly",
		{ timeout: 600_000 },
		(_case, input) => {
			assertGrowsLinearly((text) => {
				redactText(text);
			}, input);
		},
	);
});

// Against the scrubber as it stood before (vendored under test/fixtures): on
// generated texts full of credential shapes and control characters, every
// marker half the old one hid stays hidden; and the scrubber is linear on runs
// of every character class and pair of them.
describe("redactText against the scrubber it replaced", () => {
	it.each(DEEP_SEEDS)("hides every marker the old scrubber hid (seed %i)", {
		timeout: 600_000,
	}, (seed) => {
		expect(
			assertRevealsNoMore(baseRedactText, redactText, {
				count: 50_000,
				seed,
				kept: KEPT_LOCATOR,
			}),
		).toBeGreaterThan(1000);
	});

	it("grows linearly on the whole sweep", { timeout: 600_000 }, () => {
		assertSweepLinear((text) => redactText(text), {
			alphabet: "aZ9",
			words: ["eyJ", KEY_LINE, `${KEY_LINE}\nabc\n${END_LINE}`, "Bearer "],
			// A key, a run and an END line after it: B-1 in 0462fa6c.
			fragments: ["-----END"],
		});
	});
});

// Each of redactText's patterns and its key-name test, on runs of every class and between its own
// fragments (`patternFragments`), but those core shares, which core sweeps.
describe("each pattern on the whole sweep", () => {
	it.each(
		ownPatterns(
			[...SECRET_TEXT_PATTERNS, SECRET_KEY_PATTERN],
			SHARED_PATTERNS,
		).map((pattern) => [pattern.source, pattern] as const),
	)("/%s/ grows linearly", { timeout: 600_000 }, (_source, pattern) => {
		assertPatternSweepLinear(pattern, searchAsRedactor);
	});
});
