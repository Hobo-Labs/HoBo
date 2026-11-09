/**
 * `redactSecrets` and `looksLikeSecret` take the shared linear JWT pattern
 * (`@hobo/provider-redaction`). Their own `\beyJ…` pattern started again
 * at every `eyJ` in a run and read to its end, so a runner log holding a
 * megabyte of `-eyJ` stalled both. These pin that a JWT is still found and
 * redacted, and that both are linear.
 */

import {
	assertPatternSweepLinear,
	assertSweepLinear,
	ownPatterns,
} from "@hobo/provider-redaction/linear-sweep";
import {
	assertGrowsLinearly,
	repeatedTo,
} from "@hobo/provider-redaction/linear-time";
import { assertRevealsNoMore } from "@hobo/provider-redaction/redaction-differential";
import { describe, expect, it } from "vitest";
import {
	looksLikeSecret,
	OPAQUE_RUN,
	redactSecrets,
	SECRET_PATTERNS,
} from "../src/runner-integrations.js";
import { redactSecrets as baseRedactSecrets } from "./fixtures/base-redaction.js";

const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJnaXRodWIifQ.c2lnbmF0dXJlLXZhbHVl";

describe("runner-integration secret patterns", () => {
	it("still finds and redacts a JWT, alone or after a hyphen", () => {
		for (const before of ["", "x-"]) {
			expect(looksLikeSecret(`${before}${JWT}`)).toBe(true);
			// The word before a hyphen is kept, as #1773 keeps it.
			expect(redactSecrets(`log ${before}${JWT} done`)).toBe(
				`log ${before}[REDACTED] done`,
			);
		}
	});

	it("does not count an unsigned token, nor swallow what follows a signature", () => {
		expect(looksLikeSecret("eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.")).toBe(false);
		expect(redactSecrets(`{"jwt":"${JWT}","next":"kept"}`)).toBe(
			'{"jwt":"[REDACTED]","next":"kept"}',
		);
	});

	it.each([
		["-eyJ", repeatedTo("-eyJ")],
		["-eyJ signed and short", repeatedTo("-eyJAAAAAAAA.AAAAAAAA.")],
		["eyJ runs ending in a dot", repeatedTo("-eyJAAAAAAAA.")],
	] as const)(
		"redacting %s grows linearly",
		{ timeout: 30_000 },
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
	it("hides every marker the old redactor hid", { timeout: 60_000 }, () => {
		expect(
			assertRevealsNoMore(
				(text) => baseRedactSecrets(text, []),
				(text) => redactSecrets(text, []),
				{ count: 50_000 },
			),
		).toBeGreaterThan(1000);
	});

	it("finds a key whose BEGIN line a key before it took", () => {
		// Replaced in turn, the first key's END line took the BEGIN glued after
		// it, and the second key was not found.
		const two =
			"-----BEGIN PRIVATE KEY-----\nA\n-----END PRIVATE KEY----------BEGIN PRIVATE KEY-----SECRPEM2 x";
		expect(redactSecrets(two)).not.toContain("SECRPEM2");
	});

	it("grows linearly on the whole sweep", { timeout: 60_000 }, () => {
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
		ownPatterns([...SECRET_PATTERNS, OPAQUE_RUN]).map(
			(pattern) => [pattern.source, pattern] as const,
		),
	)("/%s/ grows linearly", { timeout: 60_000 }, (_source, pattern) => {
		assertPatternSweepLinear(pattern);
	});
});
