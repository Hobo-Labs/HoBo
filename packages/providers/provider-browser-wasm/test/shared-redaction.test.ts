/**
 * `redactHostText` is the shared redactor (`@hobo/core/provider-redaction`)
 * with no shapes of its own. Before the move it had its own copy, whose JWT
 * shape started again at every `eyJ` and ran to the end. These pin that
 * nothing it redacted leaks now, what it newly redacts, and that it is linear.
 */
import { assertGrowsLinearly, repeatedTo } from "@hobo/core/linear-time";
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

	it.each([["-eyJ", repeatedTo("-eyJ")]] as const)(
		"redacting %s grows linearly",
		{ timeout: 30_000 },
		(_case, input) => {
			assertGrowsLinearly((text) => {
				redactHostText(text, 8 * MB);
			}, input);
		},
	);
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
		expect(redactHostText(text)).toBe("before [redacted] after");
	});
});
