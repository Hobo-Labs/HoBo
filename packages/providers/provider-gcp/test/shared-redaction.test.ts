/**
 * `redactGcpText` is the shared redactor (`@hobo/core/provider-redaction`) plus its
 * rule that any long token-shaped run is a credential. Before the move that
 * rule was all it had, so a secret shorter than the rule — a password, a short
 * bearer token, URL credentials, a private key's BEGIN line — reached the
 * message, and so did control characters. These pin that what the rule caught
 * is still caught, what it missed is caught now, and that it is linear.
 */

import {
	assertPatternSweepLinear,
	profilePatterns,
} from "@hobo/core/linear-sweep";
import { assertGrowsLinearly, repeatedTo } from "@hobo/core/linear-time";
import { assertRevealsNoMore } from "@hobo/core/redaction-differential";
import { describe, expect, it } from "vitest";

import { GCP_REDACTION_PROFILE, redactGcpText } from "../src/resolvers.js";
import { redactGcpText as baseRedact } from "./fixtures/base-redaction.js";

const MB = 1_000_000;
const redact = (text: string, limit?: number) => redactGcpText(text, limit);

describe("redactGcpText", () => {
	it("still redacts every long token-shaped run", () => {
		expect(redact(`denied for ${"A1b2".repeat(8)} here`)).toBe(
			"denied for [redacted] here",
		);
	});

	it("now also redacts short secrets and flattens control characters", () => {
		// Each of these reached the message before.
		for (const secret of [
			"password=hunter2",
			"Bearer abc123",
			"https://user:pw@host/x",
			"-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----",
		])
			expect(redact(`denied ${secret} here`)).toBe("denied [redacted] here");
		expect(redact("line one\n\u001b[31mforged")).toBe("line one  [31mforged");
	});

	it("keeps its limit of 400 characters", () => {
		expect(redact("ab ".repeat(300))).toHaveLength(401);
	});

	it.each([
		["-ey", repeatedTo("-ey")],
		["BEGIN markers", repeatedTo("-----BEGIN PRIVATE KEY-----")],
		["short runs", repeatedTo("a.")],
	] as const)(
		"redacting %s grows linearly",
		{ timeout: 30_000 },
		(_case, input) => {
			assertGrowsLinearly((text) => {
				redact(text, 8 * MB);
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
		expect(redact(text)).toBe("before [redacted] after");
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
			(text) => redactGcpText(text, LONG),
			{ count: 50_000 },
		);
		expect(hidden).toBeGreaterThan(1000);
	});
	it.each([
		["Bearer abcd\u0007SECRCTL3 ok", "SECRCTL3"],
		["token=abcd\u0000SECRCTL2tail", "SECRCTL2"],
	])("reads a credential on through a control character: %j", (text, marker) => {
		expect(redactGcpText(text, LONG)).not.toContain(marker);
	});
	it.each(
		profilePatterns(GCP_REDACTION_PROFILE).map(
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
