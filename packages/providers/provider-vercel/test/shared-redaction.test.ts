/**
 * Vercel's redactor is the shared one (`@hobo/core/provider-redaction`, whose
 * tests hold the hostile-text cases first written here) plus Vercel's claim
 * and transfer codes. Before the move it had its own copy of the shapes; these
 * pin that nothing it redacted leaks now, what it newly redacts, and that its
 * own shape is linear.
 */
import { assertGrowsLinearly, repeatedTo } from "@hobo/core/linear-time";
import { describe, expect, it } from "vitest";

import { REDACTION_WINDOW, redactProviderText } from "../src/index.js";

const MB = 1_000_000;

describe("provider-vercel redaction", () => {
	it("still redacts every shape its own copy did", () => {
		for (const secret of [
			"prisma+postgres://accelerate.prisma-data.net/?api_key=abc",
			"postgresql://user:pw@host/db",
			"api_key=abc123",
			"Bearer abc123",
			"pgpassword=hunter2",
			"code=ABCDEFGH-1234",
			"sk_live_abcdefgh",
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.sig",
			"-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----",
		])
			expect(redactProviderText(`before ${secret} after`)).toBe(
				"before [redacted] after",
			);
		expect(REDACTION_WINDOW).toBe(8192);
	});

	it("now also redacts a token, a JWT after a hyphen, and URL credentials", () => {
		// Each of these left the secret in the message before.
		for (const secret of [
			"VERCEL_TOKEN=vcp_abcdef",
			"x-eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.sig",
			"https://user:hunter2@example.com/x",
			"ghp_abcdefghijklmnop",
		])
			expect(redactProviderText(`before ${secret} after`)).toBe(
				"before [redacted] after",
			);
	});

	it.each([["near-miss transfer codes", repeatedTo("code=ABC ")]] as const)(
		"redacting %s grows linearly",
		{ timeout: 30_000 },
		(_case, input) => {
			assertGrowsLinearly((text) => {
				redactProviderText(text, 8 * MB);
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
		expect(redactProviderText(text)).toBe("before [redacted] after");
	});
});
