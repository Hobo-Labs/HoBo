/**
 * Upstash's redactor is the shared one (`@hobo/provider-redaction`) plus its
 * own shapes, with the text percent-decoded fully first. Before the move it
 * had its own copy, which decoded by running over the whole text again until
 * it stopped changing — one pass per layer of `%25`, so a megabyte of nested
 * encoding was quadratic — and whose private-key shape searched from every
 * BEGIN for an END. These pin that nothing it redacted leaks now, encoded or
 * not, and that it is linear.
 *
 * This is the fast tier: `shared-redaction.deep.test.ts` holds the sweeps, the
 * growth measurements and the full-size differential (`pnpm run test:deep`).
 */

import { decodePercentFully, KEPT_LOCATOR } from "@hobo/provider-redaction";
import { assertRevealsNoMore } from "@hobo/redaction-test-harness/redaction-differential";
import { describe, expect, it } from "vitest";

import { containsControlChar, redactProviderText } from "../src/errors.js";
import { redactProviderText as baseRedact } from "./fixtures/base-redaction.js";

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

	it("takes a prefixed key's whole run, not only from its prefix", () => {
		// Starting at the prefix left the run's start, part of the key, behind.
		const key = `${"A".repeat(30)}SECROPQ1-sk_${"B".repeat(20)}`;
		expect(redactProviderText(`before ${key} after`)).toBe(
			"before [redacted] after",
		);
	});

	it.each([
		"**Token:** SECRUPS2abc",
		"**Token**: SECRUPS2abc",
		"** Token ** : SECRUPS2abc",
	])("redacts the CLI's token line %j", (line) => {
		// `**Token**: …` leaked before and after the move: `\s*:?\s*` read only
		// a colon inside the emphasis.
		expect(redactProviderText(`before ${line} after`)).toBe(
			"before [redacted] after",
		);
	});

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
			{ count: 5_000, kept: KEPT_LOCATOR, decode: decodePercentFully },
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
