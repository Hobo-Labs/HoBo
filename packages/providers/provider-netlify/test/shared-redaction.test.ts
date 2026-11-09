/**
 * Netlify's redactor is the shared one (`@hobo/provider-redaction`) plus
 * the claim URL and `nf_`/`nfp_` tokens. Before the move it had its own copy,
 * and two of its shapes backtracked: the JWT shape started again at every `ey`
 * and the private-key shape searched from every BEGIN for an END, and the claim
 * URL shape scanned from every `http` to the end of the run. These pin that
 * nothing it redacted leaks now and that every shape it runs is linear; the
 * receipt scanner's detectors are held to the same.
 *
 * This is the fast tier: `shared-redaction.deep.test.ts` holds the sweeps, the
 * growth measurements and the full-size differential (`pnpm run test:deep`).
 */

import { KEPT_LOCATOR } from "@hobo/provider-redaction";
import {
	assertFindsNoLess,
	assertRevealsNoMore,
	JWT_PIECES,
	PEM_PIECES,
	URL_PIECES,
} from "@hobo/redaction-test-harness/redaction-differential";
import { describe, expect, it } from "vitest";

import { redactProviderText } from "../src/provider-errors.js";
import { scanForCredentialMaterial } from "../src/receipt.js";
import { scanForCredentialMaterial as baseScan } from "./fixtures/base-guard.js";
import { redactProviderText as baseRedact } from "./fixtures/base-redaction.js";

describe("provider-netlify redaction", () => {
	it("still redacts every shape its own copy did", () => {
		for (const secret of [
			"https://app.netlify.com/claim#session=abc",
			"Bearer abc123",
			"nfp_abcdefgh12345678",
			"nf_abcdefgh1",
			"postgres://user:pw@db.example.com/app",
			"mysql://user:pw@db.example.com/app",
			"NETLIFY_AUTH_TOKEN=abc",
			"x_session_id=abc",
			"DB_PASSWORD=hunter2",
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.sig",
			"-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----",
		])
			expect(redactProviderText(`before ${secret}   after`)).toBe(
				"before [redacted] after",
			);
	});

	it("the receipt scanner still finds a claim URL, a JWT and a key", () => {
		const labels = (value: string) =>
			scanForCredentialMaterial(value).map((hit) => hit.label);
		expect(labels("see https://app.netlify.com/claim?x=1")).toContain(
			"claim or drop url with parameters",
		);
		expect(labels("x https://a.netlify.app/drop#t")).toContain(
			"claim or drop url with parameters",
		);
		expect(labels("https://app.netlify.com/claim")).not.toContain(
			"claim or drop url with parameters",
		);
		expect(labels("t=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.sig")).toContain(
			"jwt",
		);
		expect(labels("-----BEGIN RSA PRIVATE KEY-----")).toContain("private key");
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

// The receipt scanner against the one it replaced (vendored under
// test/fixtures): on 150k generated texts per piece set, it flags every text
// the old one flagged.

describe("scanForCredentialMaterial against the scanner it replaced", () => {
	it.each([
		["claim and drop urls", URL_PIECES],
		["jwts", JWT_PIECES],
		["private keys", PEM_PIECES],
	] as const)("on 20k texts, flags every text the old scanner flagged, on %s", (_case, pieces) => {
		expect(
			assertFindsNoLess(
				(text) => baseScan(text).length > 0,
				(text) => scanForCredentialMaterial(text).length > 0,
				pieces,
				20_000,
			),
		).toBeGreaterThan(100);
	});
});
