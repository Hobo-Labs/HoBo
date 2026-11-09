/**
 * `redactText` scrubs free text in place: unlike a provider redactor it keeps
 * line breaks and never cuts, so it takes the shared private-key and JWT
 * patterns (`@hobo/core/provider-redaction`) rather than a whole redactor.
 * Before, its own JWT pattern started again at every `eyJ` and read to the
 * end, and its private-key pattern searched from every BEGIN for an END; both
 * were quadratic in a hostile text. These pin that what it redacted it still
 * redacts, that the text is otherwise untouched, and that it is linear.
 */
import { assertGrowsLinearly, repeatedTo } from "@hobo/core/linear-time";
import { describe, expect, it } from "vitest";

import { REDACTED, redactText } from "../src/index.js";

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
	] as const)("redacting %s grows linearly", (_case, input) => {
		assertGrowsLinearly((text) => {
			redactText(text);
		}, input);
	});
});
