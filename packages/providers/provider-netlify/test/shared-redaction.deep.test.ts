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
	ownPatterns,
	type PatternSearch,
	profilePatterns,
} from "@hobo/redaction-test-harness/linear-sweep";
import {
	assertGrowsLinearly,
	repeatedTo,
} from "@hobo/redaction-test-harness/linear-time";
import {
	assertFindsNoLess,
	assertRevealsNoMore,
	DEEP_SEEDS,
	JWT_PIECES,
	PEM_PIECES,
	URL_PIECES,
} from "@hobo/redaction-test-harness/redaction-differential";
import { describe, expect, it } from "vitest";

import {
	NETLIFY_REDACTION_PROFILE,
	redactProviderText,
} from "../src/provider-errors.js";
import {
	CREDENTIAL_PATTERNS as RECEIPT_PATTERNS,
	scanForCredentialMaterial,
} from "../src/receipt.js";
import { scanForCredentialMaterial as baseScan } from "./fixtures/base-guard.js";
import { redactProviderText as baseRedact } from "./fixtures/base-redaction.js";

/** A pattern searched the way `redactMatches` searches it, made global. */
const searchAsRedactor: PatternSearch = (text, pattern) => {
	redactMatches(text, [redactionPattern(asGlobal(pattern))]);
};

const MB = 1_000_000;

describe("provider-netlify redaction", () => {
	it.each([
		["-ey", repeatedTo("-ey")],
		["BEGIN markers", repeatedTo("-----BEGIN PRIVATE KEY-----")],
		["http:// with no claim", repeatedTo("http://")],
		["a name run with no separator", repeatedTo("a")],
	] as const)(
		"redacting %s grows linearly",
		{ timeout: 600_000 },
		(_case, input) => {
			assertGrowsLinearly((text) => {
				redactProviderText(text, 8 * MB);
			}, input);
		},
	);

	it.each([
		["-ey", repeatedTo("-ey")],
		["http:// with no claim", repeatedTo("http://")],
		["http://claim with no query", repeatedTo("http://claim")],
	] as const)(
		"scanning a receipt string of %s grows linearly",
		{ timeout: 600_000 },
		(_case, input) => {
			assertGrowsLinearly((text) => {
				scanForCredentialMaterial(text);
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
	it.each(
		profilePatterns(NETLIFY_REDACTION_PROFILE).map(
			(pattern) => [pattern.source, pattern] as const,
		),
	)(
		"its pattern /%s/ grows linearly on the whole sweep",
		{ timeout: 600_000 },
		(_source, pattern) => {
			assertPatternSweepLinear(pattern, searchAsRedactor);
		},
	);
});

// The receipt scanner against the one it replaced (vendored under
// test/fixtures): on 150k generated texts per piece set, it flags every text
// the old one flagged.

describe("scanForCredentialMaterial against the scanner it replaced", () => {
	it.each([
		["claim and drop urls", URL_PIECES],
		["jwts", JWT_PIECES],
		["private keys", PEM_PIECES],
	] as const)(
		"flags every text the old scanner flagged, on %s",
		{ timeout: 600_000 },
		(_case, pieces) => {
			expect(
				assertFindsNoLess(
					(text) => baseScan(text).length > 0,
					(text) => scanForCredentialMaterial(text).length > 0,
					pieces,
				),
			).toBeGreaterThan(1000);
		},
	);
});

// Each of the receipt scanner's patterns, on runs of every class and between its own
// fragments (`patternFragments`): the sweep above runs them together on runs.
describe("each pattern on the whole sweep", () => {
	it.each(
		ownPatterns(
			RECEIPT_PATTERNS.map((entry) => entry.pattern),
			SHARED_PATTERNS,
		).map((pattern) => [pattern.source, pattern] as const),
	)("/%s/ grows linearly", { timeout: 600_000 }, (_source, pattern) => {
		assertPatternSweepLinear(pattern, searchAsRedactor);
	});
});
