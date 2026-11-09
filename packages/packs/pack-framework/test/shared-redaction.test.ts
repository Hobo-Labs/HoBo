/**
 * `redactPackText` is the shared redactor (`@hobo/core/provider-redaction`)
 * with no shapes of its own. Before the move it had its own copy, whose
 * private-key shape searched from every BEGIN for an END that never came.
 * These pin that nothing it redacted leaks now, what it newly redacts, and
 * that it is linear.
 */
import { assertGrowsLinearly, repeatedTo } from "@hobo/core/linear-time";
import { describe, expect, it } from "vitest";

import { redactPackText } from "../src/errors.js";

const MB = 1_000_000;

describe("redactPackText", () => {
	it("still redacts every shape its own copy did", () => {
		for (const secret of [
			"postgres://user:pw@db/app",
			"redis://default:pw@cache:6379",
			"Bearer abc123",
			"--requirepass=s3cret",
			"PGPASSWORD=s3cret",
			"pwd: s3cret",
			"-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----",
		])
			expect(redactPackText(`before ${secret} after`)).not.toMatch(
				/pw@|abc123|s3cret|MIIB/u,
			);
	});

	it("now also redacts a token, a JWT, and a key with no END line", () => {
		for (const secret of [
			"REGISTRY_TOKEN=abc123",
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.c2lnbmF0dXJl",
			"-----BEGIN PRIVATE KEY-----\nMIIB and the rest",
		])
			expect(redactPackText(`before ${secret}`)).toBe("before [redacted]");
	});

	it.each([
		["BEGIN markers", repeatedTo("-----BEGIN PRIVATE KEY-----")],
	] as const)(
		"redacting %s grows linearly",
		{ timeout: 30_000 },
		(_case, input) => {
			assertGrowsLinearly((text) => {
				redactPackText(text, 8 * MB);
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
		expect(redactPackText(text)).toBe("before [redacted] after");
	});
});
