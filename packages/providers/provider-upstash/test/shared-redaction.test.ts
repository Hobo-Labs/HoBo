/**
 * Upstash's redactor is the shared one (`@hobo/core/provider-redaction`) plus its
 * own shapes, with the text percent-decoded fully first. Before the move it
 * had its own copy, which decoded by running over the whole text again until
 * it stopped changing — one pass per layer of `%25`, so a megabyte of nested
 * encoding was quadratic — and whose private-key shape searched from every
 * BEGIN for an END. These pin that nothing it redacted leaks now, encoded or
 * not, and that it is linear.
 */
import { assertGrowsLinearly, repeatedTo } from "@hobo/core/linear-time";
import { describe, expect, it } from "vitest";

import { containsControlChar, redactProviderText } from "../src/errors.js";

const MB = 1_000_000;

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
		["nested %25", (length: number) => `%${"25".repeat(length / 2)}41`],
		["BEGIN markers", repeatedTo("-----BEGIN PRIVATE KEY-----")],
		["-ey", repeatedTo("-ey")],
	] as const)(
		"redacting %s grows linearly",
		{ timeout: 30_000 },
		(_case, input) => {
			assertGrowsLinearly((text) => {
				redactProviderText(text, 8 * MB);
			}, input);
		},
	);

	it("still reports control characters", () => {
		expect(containsControlChar("a\u001b[31m")).toBe(true);
		expect(containsControlChar("plain")).toBe(false);
	});
});

// The same three secrets, redacted whole, by every caller of the shared
// redactor: a JWT with a long header and signature (a generic long-run rule
// searched first split one and left its payload), a private key, and a URL
// with credentials.
describe("the shared shapes, through this caller", () => {
	const header = `eyJ${"h".repeat(53)}`;
	const payload = "eyJzdWIiOiJhZG1pbiIsInJvbGUiOiJyb290In0";
	const signature = "s".repeat(48);
	it.each([
		["a JWT", `${header}.${payload}.${signature}`],
		[
			"a private key",
			"-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
		],
		["a URL with credentials", "https://admin:hunter2@db.example.com/app"],
	])("redacts %s whole", (_case, secret) => {
		const text = `before ${secret} after`;
		expect(redactProviderText(text)).toBe("before [redacted] after");
	});
});
