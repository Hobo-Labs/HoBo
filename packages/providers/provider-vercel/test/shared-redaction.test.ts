/**
 * Vercel's redactor is the shared one (`@hobo/provider-redaction`, whose
 * tests hold the hostile-text cases first written here) plus Vercel's claim
 * and transfer codes. Before the move it had its own copy of the shapes; these
 * pin that nothing it redacted leaks now, what it newly redacts, and that its
 * own shape is linear.
 */

import {
	assertPatternSweepLinear,
	profilePatterns,
} from "@hobo/provider-redaction/linear-sweep";
import { assertGrowsLinearly, repeatedTo } from "@hobo/provider-redaction/linear-time";
import { assertRevealsNoMore } from "@hobo/provider-redaction/redaction-differential";
import { describe, expect, it } from "vitest";

import { REDACTION_WINDOW, redactProviderText } from "../src/index.js";
import { VERCEL_REDACTION_PROFILE } from "../src/provider-errors.js";
import { redactProviderText as baseRedact } from "./fixtures/base-redaction.js";
import { redactProviderText as mainRedact } from "./fixtures/main-redaction.js";

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

// #1773's hostile-text assertions (9d3fe8c2), through this caller.
describe("a JWT after a boundary, as #1773 pins it", () => {
	const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.dBjftJeZ4CVPmB92K";
	it.each([
		" ",
		'"',
		"=",
		":",
		"-",
	])("redacts a JWT that follows %j", (before) => {
		expect(redactProviderText(`x${before}${jwt}`)).toBe(`x${before}[redacted]`);
	});

	it("takes a hyphen inside a word as a boundary, as the old `\\bey` had it", () => {
		expect(redactProviderText(`token-${jwt} end`)).toBe("token-[redacted] end");
	});
});

// Against the redactor this caller had before (vendored under test/fixtures):
// on generated texts full of credential shapes, separators and control
// characters, every marker half the old one hid stays hidden, and every
// pattern this caller adds is linear on every class and pair of classes.
describe("against the redactor it replaced", () => {
	const LONG = 1_000_000;
	it("hides every marker the base branch's redactor hid", {
		timeout: 60_000,
	}, () => {
		const hidden = assertRevealsNoMore(
			(text) => baseRedact(text, LONG),
			(text) => redactProviderText(text, LONG),
			{ count: 20_000 },
		);
		expect(hidden).toBeGreaterThan(1000);
	});
	it("hides every marker main's redactor hid", { timeout: 60_000 }, () => {
		const hidden = assertRevealsNoMore(
			(text) => mainRedact(text, LONG),
			(text) => redactProviderText(text, LONG),
			{ count: 20_000 },
		);
		expect(hidden).toBeGreaterThan(1000);
	});
	it.each([
		["Bearer abcd\u0007SECRCTL3 ok", "SECRCTL3"],
		["token=abcd\u0000SECRCTL2tail", "SECRCTL2"],
	])("reads a credential on through a control character: %j", (text, marker) => {
		expect(redactProviderText(text, LONG)).not.toContain(marker);
	});
	it.each(
		profilePatterns(VERCEL_REDACTION_PROFILE).map(
			(pattern) => [pattern.source, pattern] as const,
		),
	)(
		"its pattern /%s/ grows linearly on the whole sweep",
		{ timeout: 30_000 },
		(_source, pattern) => {
			assertPatternSweepLinear(pattern);
		},
	);
});
