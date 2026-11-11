import {
	assertFindsNoLess,
	JWT_PIECES,
	PEM_PIECES,
} from "@hobo/redaction-test-harness/redaction-differential";
import { describe, expect, it } from "vitest";
import { anyCase } from "../src/any-case.js";
import {
	JWT_DETECTOR,
	PRIVATE_KEY_DETECTOR,
	redactProviderText,
} from "../src/provider-redaction.js";

// The detectors the claims, recipes, netlify-receipt and conformance guards
// had, as they stood before they took the shared ones: on 20k generated texts
// each, the shared detector finds every text the old one found (150k in the deep
// tier).
describe("the shared detectors against the ones they replaced", () => {
	const finds = (pattern: RegExp) => (text: string) => pattern.test(text);
	it.each([
		[
			"the claims, recipes and netlify JWT detector",
			/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./u,
			JWT_DETECTOR,
			JWT_PIECES,
		],
		[
			"the conformance JWT detector",
			/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
			JWT_DETECTOR,
			JWT_PIECES,
		],
		[
			"every guard's private-key detector",
			/-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
			PRIVATE_KEY_DETECTOR,
			PEM_PIECES,
		],
	] as const)("%s finds nothing the shared one misses", (_case, old, now, pieces) => {
		expect(
			assertFindsNoLess(finds(old), finds(now), pieces, 20_000),
		).toBeGreaterThan(100);
	});

	it("a hostname with ey in it is not a JWT to either", () => {
		const host = "see my-eyewear-store.myshopify.com.example.internal.";
		expect(JWT_DETECTOR.test(host)).toBe(false);
		expect(redactProviderText(host)).toBe(host.trim());
	});
});

describe("anyCase", () => {
	it("matches every case a word matched under iu, and nothing it did not", () => {
		const spelled = new RegExp(`^(?:${anyCase("token|sk")})$`, "u");
		const folded = /^(?:token|sk)$/iu;
		for (const word of [
			"token",
			"TOKEN",
			"toKen",
			"to\u212Aen",
			"\u017Fk",
			"S\u212A",
			"tokens",
			"t0ken",
			"sx",
		])
			expect(spelled.test(word)).toBe(folded.test(word));
	});
});
