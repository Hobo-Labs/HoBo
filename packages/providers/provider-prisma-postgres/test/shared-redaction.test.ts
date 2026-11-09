/**
 * Prisma Postgres's redactor is the shared one (`@hobo/provider-redaction`) plus its
 * own shapes, with the text percent-decoded fully first. Before the move it
 * had its own copy, which decoded by running over the whole text again until
 * it stopped changing — one pass per layer of `%25`, so a megabyte of nested
 * encoding was quadratic — and whose private-key shape searched from every
 * BEGIN for an END. These pin that nothing it redacted leaks now, encoded or
 * not, and that it is linear.
 */

import { decodePercentFully } from "@hobo/provider-redaction";
import {
	assertPatternSweepLinear,
	profilePatterns,
} from "@hobo/provider-redaction/linear-sweep";
import {
	assertGrowsLinearly,
	repeatedTo,
} from "@hobo/provider-redaction/linear-time";
import { assertRevealsNoMore } from "@hobo/provider-redaction/redaction-differential";
import { describe, expect, it } from "vitest";

import {
	containsControlChar,
	PRISMA_POSTGRES_REDACTION_PROFILE,
	redactProviderText,
} from "../src/errors.js";
import { ARGV_CREDENTIAL_PATTERNS } from "../src/migration.js";
import { redactProviderText as baseRedact } from "./fixtures/base-redaction.js";

const MB = 1_000_000;

describe("provider-prisma-postgres redaction", () => {
	it("still redacts every shape its own copy did", () => {
		for (const secret of [
			"Bearer abc123",
			"password=hunter2",
			"-----BEGIN PRIVATE KEY-----\\nMIIB\\n-----END PRIVATE KEY-----",
			"0b2f8a4e-1c3d-4e5f-8a9b-0c1d2e3f4a5b",
			"https://create-db.prisma.io/claim?projectID=proj_abc",
			"proj_abcdef",
			"postgres://u:p@db.prisma.io:5432/postgres",
			"prisma+postgres://accelerate.prisma-data.net/?api_key=abc",
			"api_key=abc",
		]) {
			// Its own copy left `prisma+` in front of a redacted Prisma Postgres
			// URL; the shared one takes the whole URL. Neither leaks the secret.
			const encoded = encodeURIComponent(encodeURIComponent(secret));
			for (const text of [secret, encoded]) {
				const redacted = redactProviderText(`before ${text} after`);
				expect(redacted).toMatch(/^before \S*\[redacted\] after$/u);
				expect(redacted).not.toContain(secret.slice(-6));
			}
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
			{ count: 50_000, decode: decodePercentFully },
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
		profilePatterns(PRISMA_POSTGRES_REDACTION_PROFILE).map(
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

// The argv guard's patterns: an element is at most 1024 characters, and each
// pattern is linear on runs of every class and between its own fragments.
describe("the argv guard", () => {
	it.each(
		ARGV_CREDENTIAL_PATTERNS.map(
			(pattern) => [pattern.source, pattern] as const,
		),
	)(
		"its pattern /%s/ grows linearly on the whole sweep",
		{ timeout: 60_000 },
		(_source, pattern) => {
			assertPatternSweepLinear(pattern);
		},
	);
});
