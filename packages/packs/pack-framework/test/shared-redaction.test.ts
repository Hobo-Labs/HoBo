/**
 * `redactPackText` is the shared redactor (`@hobo/provider-redaction`)
 * with no shapes of its own. Before the move it had its own copy, whose
 * private-key shape searched from every BEGIN for an END that never came.
 * These pin that nothing it redacted leaks now, what it newly redacts, and
 * that it is linear.
 *
 * This is the fast tier: `shared-redaction.deep.test.ts` holds the sweeps, the
 * growth measurements and the full-size differential (`pnpm run test:deep`).
 */

import { KEPT_LOCATOR } from "@hobo/provider-redaction";
import { assertRevealsNoMore } from "@hobo/redaction-test-harness/redaction-differential";
import { describe, expect, it } from "vitest";
import { redactPackText } from "../src/errors.js";
import { redactPackText as baseRedact } from "./fixtures/base-redaction.js";

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

// Against the redactor this caller had before (vendored under test/fixtures):
// on generated texts full of credential shapes, separators and control
// characters, every marker half the old one hid stays hidden, and every
// pattern this caller adds is linear on every class and pair of classes.
describe("against the redactor it replaced", () => {
	const LONG = 1_000_000;
	it("on 5k texts, hides every marker the base branch's redactor hid", () => {
		const hidden = assertRevealsNoMore(
			(text) => baseRedact(text, LONG),
			(text) => redactPackText(text, LONG),
			{ count: 5_000, kept: KEPT_LOCATOR },
		);
		expect(hidden).toBeGreaterThan(500);
	});
	it.each([
		["Bearer abcd\u0007SECRCTL3 ok", "SECRCTL3"],
		["token=abcd\u0000SECRCTL2tail", "SECRCTL2"],
	])("reads a credential on through a control character: %j", (text, marker) => {
		expect(redactPackText(text, LONG)).not.toContain(marker);
	});
});
