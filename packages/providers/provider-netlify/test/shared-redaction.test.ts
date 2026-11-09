/**
 * Netlify's redactor is the shared one (`@hobo/core/provider-redaction`) plus
 * the claim URL and `nf_`/`nfp_` tokens. Before the move it had its own copy,
 * and two of its shapes backtracked: the JWT shape started again at every `ey`
 * and the private-key shape searched from every BEGIN for an END, and the claim
 * URL shape scanned from every `http` to the end of the run. These pin that
 * nothing it redacted leaks now and that every shape it runs is linear; the
 * receipt scanner's detectors are held to the same.
 */
import { assertGrowsLinearly, repeatedTo } from "@hobo/core/linear-time";
import { describe, expect, it } from "vitest";

import { redactProviderText } from "../src/provider-errors.js";
import { scanForCredentialMaterial } from "../src/receipt.js";

const MB = 1_000_000;

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

	it.each([
		["-ey", repeatedTo("-ey")],
		["BEGIN markers", repeatedTo("-----BEGIN PRIVATE KEY-----")],
		["http:// with no claim", repeatedTo("http://")],
		["a name run with no separator", repeatedTo("a")],
	] as const)("redacting %s grows linearly", (_case, input) => {
		assertGrowsLinearly((text) => {
			redactProviderText(text, 8 * MB);
		}, input);
	});

	it.each([
		["-ey", repeatedTo("-ey")],
		["http:// with no claim", repeatedTo("http://")],
		["http://claim with no query", repeatedTo("http://claim")],
	] as const)("scanning a receipt string of %s grows linearly", (_case, input) => {
		assertGrowsLinearly((text) => {
			scanForCredentialMaterial(text);
		}, input);
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
