/**
 * `redactHostText` is the shared redactor (`@hobo/core/provider-redaction`)
 * with no shapes of its own. Before the move it had its own copy, whose JWT
 * shape started again at every `eyJ` and ran to the end. These pin that
 * nothing it redacted leaks now, what it newly redacts, and that it is linear.
 */
import { describe, expect, it } from "vitest";

import { redactHostText } from "../src/errors.js";

const MB = 1_000_000;

describe("redactHostText", () => {
	it("still redacts every shape its own copy did", () => {
		for (const secret of [
			"Bearer abc123",
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.c2lnbmF0dXJl",
			"https://host/cb?access_token=abc123",
			"id_token=abc123",
			"session=abc123",
			"api-key=abc123",
			"token=abc123",
			"sk_live_abcdefgh",
		])
			expect(redactHostText(`before ${secret} after`)).not.toMatch(
				/abc123|eyJ|sk_live/u,
			);
	});

	it("now also redacts a private key and URL credentials", () => {
		for (const secret of [
			"-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----",
			"https://user:pw@host/x",
		])
			expect(redactHostText(`before ${secret} after`)).toBe(
				"before [redacted] after",
			);
	});

	it("redacts 1 MB of -eyJ in well under a second", () => {
		const hostile = "-eyJ".repeat(MB / 4);
		const started = performance.now();
		redactHostText(hostile, 2 * MB);
		expect(performance.now() - started).toBeLessThan(1000);
	});
});
