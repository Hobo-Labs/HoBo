/**
 * Upstash's redactor is the shared one (`@hobo/core/provider-redaction`) plus its
 * own shapes, with the text percent-decoded fully first. Before the move it
 * had its own copy, which decoded by running over the whole text again until
 * it stopped changing — one pass per layer of `%25`, so a megabyte of nested
 * encoding was quadratic — and whose private-key shape searched from every
 * BEGIN for an END. These pin that nothing it redacted leaks now, encoded or
 * not, and that it is linear.
 */
import { describe, expect, it } from "vitest";

import { containsControlChar, redactProviderText } from "../src/errors.js";

const MB = 1_000_000;
const repeated = (unit: string) => unit.repeat(Math.ceil(MB / unit.length));

describe("provider-upstash redaction", () => {
	it("still redacts every shape its own copy did", () => {
		for (const secret of [
			"Bearer abc123",
			"password=hunter2",
			"-----BEGIN PRIVATE KEY-----\\nMIIB\\n-----END PRIVATE KEY-----",
			"0b2f8a4e-1c3d-4e5f-8a9b-0c1d2e3f4a5b",
			"https://console.upstash.com/redis/abc",
			"UPSTASH_REDIS_REST_TOKEN=abc",
			"token=abc",
			"rediss://default:pw@us1.upstash.io:6379",
			"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		]) {
			expect(redactProviderText(`before ${secret} after`)).toBe(
				"before [redacted] after",
			);
			// Percent-encoded, twice over.
			const encoded = encodeURIComponent(encodeURIComponent(secret));
			expect(redactProviderText(`before ${encoded} after`)).toBe(
				"before [redacted] after",
			);
		}
	});

	it.each([
		["nested %25", `%${"25".repeat(MB / 2)}41`],
		["BEGIN markers", repeated("-----BEGIN PRIVATE KEY-----")],
		["-ey", repeated("-ey")],
	])("redacts 1 MB of %s in well under a second", (_case, hostile) => {
		const started = performance.now();
		redactProviderText(hostile, 2 * MB);
		expect(performance.now() - started).toBeLessThan(1000);
	});

	it("still reports control characters", () => {
		expect(containsControlChar("a\u001b[31m")).toBe(true);
		expect(containsControlChar("plain")).toBe(false);
	});
});
