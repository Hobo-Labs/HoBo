/**
 * The deep tier of this package's redaction tests (`pnpm run test:deep`): the
 * differential against what it replaced at full size, every pattern it adds
 * swept, and growth measured on hostile text. The fast tier is
 * `shared-detectors.test.ts`.
 */

import {
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
	assertFindsNoLess,
	JWT_PIECES,
	PEM_PIECES,
	URL_PIECES,
} from "@hobo/redaction-test-harness/redaction-differential";
import { describe, expect, it } from "vitest";
import { FORBIDDEN_IN_EVENTS } from "../src/events.js";
import { assertNoSecrets, type ClaimEvent } from "../src/index.js";
import { assertNoSecrets as baseAssertNoSecrets } from "./fixtures/base-guard.js";

/** A pattern searched the way `redactMatches` searches it, made global. */
const searchAsRedactor: PatternSearch = (text, pattern) => {
	redactMatches(text, [redactionPattern(asGlobal(pattern))]);
};

const observed = (observedStatus: string): ClaimEvent => ({
	type: "ClaimStatusObserved",
	itemId: "i",
	observedStatus,
});

describe("assertNoSecrets detectors", () => {
	it.each([
		["-ey", repeatedTo("-ey")],
		["http://claim?", repeatedTo("http://claim?")],
		["http://", repeatedTo("http://")],
	] as const)(
		"checking a payload of %s grows linearly",
		{ timeout: 600_000 },
		(_case, input) => {
			assertGrowsLinearly(
				(text) => {
					try {
						assertNoSecrets(observed(text));
					} catch {
						// Refusing is fine; stalling is not.
					}
				},
				input,
				// The old claim-URL detector was worse than quadratic: one call on 16
				// kB took minutes. Starting at 1 kB, it fails the measure in seconds.
				{ startLength: 1024 },
			);
		},
	);
});

// Against the guard as it stood before (vendored under test/fixtures): on
// 150k generated texts per piece set, it refuses every event the old one did.

describe("assertNoSecrets against the guard it replaced", () => {
	const refuses = (check: (event: ClaimEvent) => void) => (text: string) => {
		try {
			check(observed(text));
			return false;
		} catch {
			return true;
		}
	};
	it.each([
		["claim urls", URL_PIECES],
		["jwts", JWT_PIECES],
		["private keys", PEM_PIECES],
	] as const)(
		"refuses every event the old guard refused, on %s",
		{ timeout: 600_000 },
		(_case, pieces) => {
			expect(
				assertFindsNoLess(
					refuses(baseAssertNoSecrets),
					refuses(assertNoSecrets),
					pieces,
				),
			).toBeGreaterThan(1000);
		},
	);
});

// Each of the event guard's patterns, on runs of every class and between its own
// fragments (`patternFragments`), but those core shares, which core sweeps.
describe("each pattern on the whole sweep", () => {
	it.each(
		ownPatterns(
			FORBIDDEN_IN_EVENTS.map((entry) => entry.pattern),
			SHARED_PATTERNS,
		).map((pattern) => [pattern.source, pattern] as const),
	)("/%s/ grows linearly", { timeout: 600_000 }, (_source, pattern) => {
		assertPatternSweepLinear(pattern, searchAsRedactor);
	});
});
