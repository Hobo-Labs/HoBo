/**
 * ttl.sh's redactor is the shared one (`@hobo/provider-redaction`) plus
 * `Basic` credentials and long opaque runs, with digests kept whole. Before the
 * move it had its own copy, whose JWT and private-key shapes backtracked
 * (every `ey` and every BEGIN started a search to the end) and whose opaque-run
 * shape could start at every word boundary inside a run. These pin that
 * nothing it redacted leaks now, that digests still survive, and that the
 * shapes are linear.
 *
 * This is the fast tier: `shared-redaction.deep.test.ts` holds the sweeps, the
 * growth measurements and the full-size differential (`pnpm run test:deep`).
 */

import { JWT_DETECTOR, KEPT_LOCATOR } from "@hobo/provider-redaction";
import {
	assertFindsNoLess,
	assertRevealsNoMore,
	JWT_PIECES,
} from "@hobo/redaction-test-harness/redaction-differential";
import { describe, expect, it } from "vitest";

import { containsControlChar, redactProviderText } from "../src/errors.js";
import { ARGV_CREDENTIAL_PATTERNS } from "../src/push.js";
import { redactProviderText as baseRedact } from "./fixtures/base-redaction.js";

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
	it("on 5k texts, hides every marker the base branch's redactor hid", () => {
		const hidden = assertRevealsNoMore(
			(text) => baseRedact(text, LONG),
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

// The argv guard's patterns: an element is at most 1024 characters, and each
// pattern is linear on runs of every class and between its own fragments.
describe("the argv guard", () => {
	it("on 20k texts, refuses every JWT the `\\bey…` detector it replaced refused", () => {
		const old = /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./u;
		expect(ARGV_CREDENTIAL_PATTERNS).toContain(JWT_DETECTOR);
		expect(
			assertFindsNoLess(
				(text) => old.test(text),
				(text) => JWT_DETECTOR.test(text),
				JWT_PIECES,
			),
		).toBeGreaterThan(100);
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
