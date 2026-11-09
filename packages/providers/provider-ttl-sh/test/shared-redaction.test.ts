/**
 * ttl.sh's redactor is the shared one (`@hobo/core/provider-redaction`) plus
 * `Basic` credentials and long opaque runs, with digests kept whole. Before the
 * move it had its own copy, whose JWT and private-key shapes backtracked
 * (every `ey` and every BEGIN started a search to the end) and whose opaque-run
 * shape could start at every word boundary inside a run. These pin that
 * nothing it redacted leaks now, that digests still survive, and that the
 * shapes are linear.
 */

import {
	assertPatternSweepLinear,
	profilePatterns,
} from "@hobo/core/linear-sweep";
import { assertGrowsLinearly, repeatedTo } from "@hobo/core/linear-time";
import { assertRevealsNoMore } from "@hobo/core/redaction-differential";
import { describe, expect, it } from "vitest";

import {
	containsControlChar,
	redactProviderText,
	TTL_SH_REDACTION_PROFILE,
} from "../src/errors.js";
import { redactProviderText as baseRedact } from "./fixtures/base-redaction.js";

const MB = 1_000_000;
const digest = `sha256:${"0123456789abcdef".repeat(4)}`;

describe("provider-ttl-sh redaction", () => {
	it("still redacts every shape its own copy did", () => {
		for (const secret of [
			"Bearer abc123",
			"Basic dXNlcjpwYXNz",
			"password=hunter2",
			"token: abc",
			"auth=abc",
			"ghp_abcdefghijkl",
			"glpat-abcdefghijkl",
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.sig",
			"-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----",
			"-----BEGIN PRIVATE KEY----- and no end",
			"A".repeat(48),
		])
			expect(redactProviderText(`before ${secret} after`)).not.toMatch(
				/abc|hunter2|dXNl|MIIB|AAAA|eyJ/u,
			);
		expect(redactProviderText("oci://u:pw@ttl.sh/x")).not.toContain("pw");
	});

	it("keeps digests whole, and keeps a registry path", () => {
		expect(redactProviderText(`pushed ttl.sh/app@${digest} as ${digest}`)).toBe(
			`pushed ttl.sh/app@${digest} as ${digest}`,
		);
		expect(redactProviderText("ttl.sh/hobo-abc/app:1h")).toBe(
			"ttl.sh/hobo-abc/app:1h",
		);
	});

	it.each([
		["-ey", repeatedTo("-ey")],
		["BEGIN markers", repeatedTo("-----BEGIN PRIVATE KEY-----")],
		["an opaque run of word boundaries", repeatedTo("a+")],
		["digests", repeatedTo(`${digest} `)],
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
		expect(containsControlChar("a\u0007")).toBe(true);
		expect(containsControlChar("a")).toBe(false);
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
			{ count: 50_000 },
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
		profilePatterns(TTL_SH_REDACTION_PROFILE).map(
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
