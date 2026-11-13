/**
 * The deep tier of this package's redaction tests (`pnpm run test:deep`): the
 * differential against what it replaced at full size, every pattern it adds
 * swept, and growth measured on hostile text. The fast tier is
 * `shared-detectors.test.ts`.
 */

import {
	assertPatternSweepLinear,
	type PatternSearch,
} from "@hobo/redaction-test-harness/linear-sweep";
import {
	assertGrowsLinearly,
	repeatedTo,
} from "@hobo/redaction-test-harness/linear-time";
import {
	assertFindsNoLess,
	DSN_PIECES,
	JWT_PIECES,
	PEM_PIECES,
} from "@hobo/redaction-test-harness/redaction-differential";
import { describe, expect, it } from "vitest";
import { SECRET_PATTERN } from "../src/live/evidence.js";
import { assertSanitized } from "../src/live/index.js";
import { assertSanitized as baseAssertSanitized } from "./fixtures/base-guard.js";

/** A pattern searched the way the evidence scan searches it: one `test`. */
const testSearch: PatternSearch = (text, pattern) => {
	pattern.lastIndex = 0;
	pattern.test(text);
};

function artifactNoting(note: string): Parameters<typeof assertSanitized>[0] {
	// SAFETY: a fixture holding one string is the assertSanitized input at this test boundary.
	return {
		schema: "hobo.conformance.anonymous-trust-evidence/v1",
		evidence: { note },
	} as never;
}

describe("assertSanitized detectors", () => {
	it.each([
		["-ey", repeatedTo("-ey")],
		[
			"postgres:// and colons",
			(length: number) => `postgres://${":".repeat(length)}`,
		],
		["postgres://a: with no @", repeatedTo("postgres://a:")],
		["postgres:// over and over", repeatedTo("postgres://")],
		["redis:// over and over", repeatedTo("redis://")],
		["mysql://a: with no @", repeatedTo("mysql://a:")],
		["mongodb+srv://a: with no @", repeatedTo("mongodb+srv://a:")],
		["-sk- over and over", repeatedTo("-sk-")],
		["Bearer and spaces", repeatedTo("Bearer ")],
	] as const)(
		"scanning an artifact of %s grows linearly",
		{ timeout: 600_000 },
		(_case, input) => {
			assertGrowsLinearly((text) => {
				try {
					assertSanitized(artifactNoting(text));
				} catch {
					// Refusing is fine; stalling is not.
				}
			}, input);
		},
	);

	// The patterns before this branch, which the scan must still agree with.
	const _OLD_CONNECTION_STRINGS = [
		/postgres(?:ql)?:\/\/[^\s"]*:[^\s"]*@/iu,
		/rediss?:\/\/[^\s"]*:[^\s"]*@/iu,
		/mysql:\/\/[^\s"]*:[^\s"]*@/iu,
		/mongodb(?:\+srv)?:\/\/[^\s"]*:[^\s"]*@/iu,
	];

	// A small deterministic generator, so a failure names a text that replays.
	function* _notes(count: number) {
		const alphabet = [
			"postgres://",
			"postgresql://",
			"rediss://",
			"redis://",
			"mysql://",
			"mongodb+srv://",
			"a",
			":",
			"@",
			"/",
			" ",
			'"',
			"x:y@",
		];
		let seed = 20261109;
		for (let index = 0; index < count; index++) {
			let note = "";
			for (let unit = 0; unit < 1 + (index % 12); unit++) {
				seed = (seed * 1103515245 + 12345) % 2147483648;
				note += alphabet[seed % alphabet.length];
			}
			yield note;
		}
	}
});

// Against the scan as it stood before (vendored under test/fixtures): on 150k
// generated texts per piece set, it refuses every artifact the old one did.

describe("assertSanitized against the scan it replaced", () => {
	const refuses =
		(check: (artifact: Parameters<typeof assertSanitized>[0]) => void) =>
		(text: string) => {
			try {
				check(artifactNoting(text));
				return false;
			} catch {
				return true;
			}
		};
	it.each([
		["connection strings", DSN_PIECES],
		["jwts", JWT_PIECES],
		["private keys", PEM_PIECES],
	] as const)(
		"refuses every artifact the old scan refused, on %s",
		{ timeout: 600_000 },
		(_case, pieces) => {
			expect(
				assertFindsNoLess(
					refuses(baseAssertSanitized),
					refuses(assertSanitized),
					pieces,
				),
			).toBeGreaterThan(1000);
		},
	);
});

// Each of the evidence scan's patterns, on runs of every class and between its own
// fragments (`patternFragments`): the sweep above runs them together on runs.
describe("each pattern on the whole sweep", () => {
	it.each(SECRET_PATTERN.map((pattern) => [pattern.source, pattern] as const))(
		"/%s/ grows linearly",
		{ timeout: 600_000 },
		(_source, pattern) => {
			assertPatternSweepLinear(pattern, testSearch);
		},
	);
});
