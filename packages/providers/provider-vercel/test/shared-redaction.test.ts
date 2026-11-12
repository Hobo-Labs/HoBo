/**
 * Vercel's redactor is the shared one (`@hobo/provider-redaction`; #1773's
 * hostile-text cases stay in `redaction-hostile-text.test.ts`) plus Vercel's claim
 * and transfer codes. Before the move it had its own copy of the shapes; these
 * pin that nothing it redacted leaks now, what it newly redacts, and that its
 * own shape is linear.
 *
 * This is the fast tier: `shared-redaction.deep.test.ts` holds the sweeps, the
 * growth measurements and the full-size differential (`pnpm run test:deep`).
 */

import { KEPT_LOCATOR } from "@hobo/provider-redaction";
import { assertRevealsNoMore } from "@hobo/redaction-test-harness/redaction-differential";
import { describe, expect, it } from "vitest";

import { REDACTION_WINDOW, redactProviderText } from "../src/index.js";
import { redactProviderText as baseRedact } from "./fixtures/base-redaction.js";
import { redactProviderText as mainRedact } from "./fixtures/main-redaction.js";

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
			"https://user:hunter2@example.com/x",
			"ghp_abcdefghijklmnop",
		])
			expect(redactProviderText(`before ${secret} after`)).toBe(
				"before [redacted] after",
			);
		// The word before a hyphen is kept, as #1773 keeps it.
		expect(
			redactProviderText(
				"before x-eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.sig after",
			),
		).toBe("before x-[redacted] after");
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

// Against the redactor this caller had before (vendored under test/fixtures):
// on generated texts full of credential shapes, separators and control
// characters, every marker half the old one hid stays hidden, and every
// pattern this caller adds is linear on every class and pair of classes.
describe("against the redactor it replaced", () => {
	const LONG = 1_000_000;
	it("on 5k texts, hides every marker the base branch's redactor hid", () => {
		const hidden = assertRevealsNoMore(
			(text) => baseRedact(text, LONG),
			(text) => redactProviderText(text, LONG),
			{ count: 5_000, kept: KEPT_LOCATOR },
		);
		expect(hidden).toBeGreaterThan(500);
	});
	it("on 5k texts, hides every marker main's redactor hid", () => {
		const hidden = assertRevealsNoMore(
			(text) => mainRedact(text, LONG),
			(text) => redactProviderText(text, LONG),
			{ count: 5_000, kept: KEPT_LOCATOR },
		);
		expect(hidden).toBeGreaterThan(500);
	});
	it.each([
		["Bearer abcd\u0007SECRCTL3 ok", "SECRCTL3"],
		["token=abcd\u0000SECRCTL2tail", "SECRCTL2"],
	])("reads a credential on through a control character: %j", (text, marker) => {
		expect(redactProviderText(text, LONG)).not.toContain(marker);
	});
});

// A key whose END line another shape took runs to the next BEGIN line, not to
// a `-----BEGIN` inside its body: the body was shown before.
describe("a private key's END line, taken by another shape", () => {
	it.each([
		"-----BEGIN PRIVATE KEY-----\n-----BEGINx\nSECRETBODY1\nBearer -----END PRIVATE KEY-----\n",
		"-----BEGIN PRIVATE KEY-----*\u001b-----BEGIN SECRETBODY1 Bearer -----END PRIVATE KEY-----",
	])("redacts %j whole", (text) => {
		expect(redactProviderText(text, 10_000)).toBe("[redacted]");
	});
});
