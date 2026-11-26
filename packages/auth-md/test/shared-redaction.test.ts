/**
 * `redactText` scrubs free text in place: unlike a provider redactor it keeps
 * line breaks and never cuts, so it takes the shared private-key and JWT
 * patterns (`@hobo/provider-redaction`) rather than a whole redactor.
 * Before, its own JWT pattern started again at every `eyJ` and read to the
 * end, and its private-key pattern searched from every BEGIN for an END; both
 * were quadratic in a hostile text. These pin that what it redacted it still
 * redacts, that the text is otherwise untouched, and that it is linear.
 *
 * This is the fast tier: `shared-redaction.deep.test.ts` holds the sweeps, the
 * growth measurements and the full-size differential (`pnpm run test:deep`).
 */

import { KEPT_LOCATOR } from "@hobo/provider-redaction";
import { assertRevealsNoMore } from "@hobo/redaction-test-harness/redaction-differential";
import { describe, expect, it } from "vitest";

import { REDACTED, redactText } from "../src/index.js";
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
});

// Against the scrubber as it stood before (vendored under test/fixtures): on
// generated texts full of credential shapes and control characters, every
// marker half the old one hid stays hidden; and the scrubber is linear on runs
// of every character class and pair of them.
describe("redactText against the scrubber it replaced", () => {
	it("on 5k texts, hides every marker the old scrubber hid", () => {
		expect(
			assertRevealsNoMore(baseRedactText, redactText, {
				count: 5_000,
				kept: KEPT_LOCATOR,
			}),
		).toBeGreaterThan(500);
	});
});
