/**
 * `redactText` scrubs free text in place: unlike a provider redactor it keeps
 * line breaks and never cuts, so it takes the shared private-key and JWT
 * patterns (`@hobo/provider-redaction`) rather than a whole redactor.
 * Before, its own JWT pattern started again at every `eyJ` and read to the
 * end, and its private-key pattern searched from every BEGIN for an END; both
 * were quadratic in a hostile text. These pin that what it redacted it still
 * redacts, that the text is otherwise untouched, and that it is linear.
 */

import {
	assertPatternSweepLinear,
	assertSweepLinear,
	ownPatterns,
} from "@hobo/provider-redaction/linear-sweep";
import { assertGrowsLinearly, repeatedTo } from "@hobo/provider-redaction/linear-time";
import { assertRevealsNoMore } from "@hobo/provider-redaction/redaction-differential";
import { describe, expect, it } from "vitest";

import { REDACTED, redactText } from "../src/index.js";
import { SECRET_KEY_PATTERN, SECRET_TEXT_PATTERNS } from "../src/redaction.js";
import { redactText as baseRedactText } from "./fixtures/base-redaction.js";

describe("redactText", () => {
	it("still redacts every shape its own patterns did", () => {
		for (const secret of [
			"eyJabcd.efgh.ijkl",
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZ2VudCJ9.c2lnbmF0dXJlLXZhbHVl",
			"x-eyJabcd.efgh.ijkl",
			"-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkq\n-----END PRIVATE KEY-----",
			"-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn\n-----END OPENSSH PRIVATE KEY-----",
			"Bearer abcdef0123456789",
			"A".repeat(48),
		]) {
			const redacted = redactText(`before ${secret} after`);
			expect(redacted).toContain(REDACTED);
			expect(redacted).not.toMatch(/eyJ|MIIB|b3Bl|abcdef01|AAAA/u);
			expect(redacted.endsWith(" after")).toBe(true);
		}
	});

	it("keeps line breaks and length: it scrubs, it does not cut", () => {
		const text = `line one\nline two ${"word ".repeat(200)}`;
		expect(redactText(text)).toBe(text);
	});

	it("now also redacts a private key whose END line is missing", () => {
		// Before, the pattern needed the END line and left the key whole.
		expect(
			redactText("key -----BEGIN EC PRIVATE KEY-----\nMIIBOg and on"),
		).toBe(`key ${REDACTED}`);
	});

	it.each([
		["-eyJ", repeatedTo("-eyJ")],
		["BEGIN markers", repeatedTo("-----BEGIN PRIVATE KEY-----")],
		["short runs", repeatedTo(`${"a-".repeat(19)}. `)],
		// A signature ending in `-`, which a trailing `\b` would refuse, after
		// a run of `eyJ-`: each `eyJ` started the short-JWT search again.
		[
			"eyJ- runs and a signature ending in -",
			(length: number) => `${"eyJ-".repeat(Math.ceil(length / 4))}x.aaaa.----`,
		],
	] as const)(
		"redacting %s grows linearly",
		{ timeout: 30_000 },
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
	it("hides every marker the old scrubber hid", { timeout: 60_000 }, () => {
		expect(
			assertRevealsNoMore(baseRedactText, redactText, { count: 50_000 }),
		).toBeGreaterThan(1000);
	});

	it("grows linearly on the whole sweep", { timeout: 60_000 }, () => {
		assertSweepLinear((text) => redactText(text), {
			alphabet: "aZ9",
			words: [
				"eyJ",
				"-----BEGIN PRIVATE KEY-----",
				"-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
				"Bearer ",
			],
			// A key, a run and an END line after it: B-1 in 0462fa6c.
			fragments: ["-----END"],
		});
	});
});

// Each of redactText's patterns and its key-name test, on runs of every class and between its own
// fragments (`patternFragments`), but those core shares, which core sweeps.
describe("each pattern on the whole sweep", () => {
	it.each(
		ownPatterns([...SECRET_TEXT_PATTERNS, SECRET_KEY_PATTERN]).map(
			(pattern) => [pattern.source, pattern] as const,
		),
	)("/%s/ grows linearly", { timeout: 60_000 }, (_source, pattern) => {
		assertPatternSweepLinear(pattern);
	});
});
