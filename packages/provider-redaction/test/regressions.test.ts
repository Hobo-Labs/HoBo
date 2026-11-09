/**
 * The shared redactor's regressions, fast tier: every hostile input a review
 * found a quadratic search on, screened once each (`adversarial.ts`,
 * `assertInputLinear`), and round 5's leaks as the inputs that showed them.
 * Rounds 1 to 4's leaks are pinned in `provider-redaction.test.ts`, each as a
 * fixed input.
 */
import { assertInputLinear } from "@hobo/redaction-test-harness/linear-sweep";
import { describe, expect, it } from "vitest";
import {
	CREDENTIAL_PATTERNS,
	redactMatches,
	redactProviderText,
} from "../src/provider-redaction.js";
import { adversarial, MB } from "./adversarial.js";

// Every hostile input a review found a quadratic search on, screened once each
// against a linear scan (`assertInputLinear`): about a millisecond for a linear
// redactor, and a growth measurement only for one that looks quadratic.
describe("each hostile input a review found", () => {
	it.each(
		adversarial.map((entry) => [entry.name, entry] as const),
	)("%s: the whole redactor screens linear", (name, entry) => {
		assertInputLinear(
			(text) => {
				redactProviderText(text, 8 * MB);
			},
			entry.text,
			name,
		);
	});
});

// Round 5's leaks, each as the input that showed it.
describe("round 5's leaks", () => {
	const jwt = "eyJhbGciOiJIUzI1NiJ9-x.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlLXNpZw";
	it.each([
		[
			"a key whose BEGIN label a JWT with a `-` runs through",
			`-----BEGIN ${jwt} PRIVATE KEY-----\nMIIEvQSECRETBODY\n-----END PRIVATE KEY-----`,
			["SECRETBODY"],
		],
		[
			"a chain of such BEGIN lines",
			`-----BEGIN ${jwt} -----BEGIN ${jwt} PRIVATE KEY-----\nSECRETONE\n-----END PRIVATE KEY----- PRIVATE KEY-----\nSECRETTWO\n-----END PRIVATE KEY-----`,
			["SECRETONE", "SECRETTWO"],
		],
		[
			"BEGIN lines nested twelve deep around a key",
			`${`-----BEGIN ${jwt} `.repeat(12)}PRIVATE KEY-----\nSECRETONE\n-----END PRIVATE KEY-----${" PRIVATE KEY-----\nSECRETTWO\n-----END PRIVATE KEY-----".repeat(12)}`,
			["SECRETONE", "SECRETTWO"],
		],
		[
			"a lower-case END line, which no key ends on",
			"-----BEGIN RSA PRIVATE KEY-----\nSECRETA\n-----end rsa private key-----\nSECRETB tail",
			["SECRETA", "SECRETB"],
		],
	] as const)("redacts %s", (_case, text, secrets) => {
		const out = redactMatches(text, CREDENTIAL_PATTERNS);
		for (const secret of secrets) expect(out).not.toContain(secret);
	});

	it.each([
		["ſ", "\u017F"],
		["K", "\u212A"],
	])("finds a credential after %s, now that run starts hold it", (_case, letter) => {
		for (const credential of [
			"ghp_SECRB2GHPabcdefghijklmnop",
			"sk_live_SECRB2SKabcdefghijkl",
			"Bearer SECRB2BEARER",
			"password=SECRB2PW",
			"https://user:SECRB2URL@host",
		])
			expect(redactProviderText(`x ${letter}${credential} y`)).not.toContain(
				"SECRB2",
			);
	});
});
