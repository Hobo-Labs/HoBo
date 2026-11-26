import { describe, expect, it } from "vitest";

import type {
	AssertionExpectation,
	FixtureAssertionClaims,
} from "../src/index.js";
import {
	createFixtureAssertion,
	createFixtureAssertionVerifier,
	parseHttpsUrl,
	parseInstant,
	parseRegistrationRef,
	verifyIdentityAssertion,
} from "../src/index.js";
import { binding, FIXTURE_SIGNING_KEY, ISSUER, scopes } from "./fixtures.js";

const NOW = "2026-08-08T12:00:00.000Z";
const REGISTRATION_REF = "reg_01H8XABCDEF";

const claims = (
	overrides: Partial<FixtureAssertionClaims> = {},
): FixtureAssertionClaims => ({
	registration_ref: REGISTRATION_REF,
	sub: "agent:bo",
	iss: ISSUER,
	aud: "https://api.example.test/",
	scopes: ["repo:read"],
	iat: "2026-08-08T11:59:00.000Z",
	exp: "2026-08-08T12:30:00.000Z",
	...overrides,
});

const expectation = (
	overrides: Partial<AssertionExpectation> = {},
): AssertionExpectation => ({
	registrationRef: parseRegistrationRef(REGISTRATION_REF),
	binding: binding(),
	issuer: parseHttpsUrl(ISSUER),
	allowedScopes: scopes("repo:read"),
	now: parseInstant(NOW),
	...overrides,
});

const verifier = createFixtureAssertionVerifier({
	signingKey: FIXTURE_SIGNING_KEY,
});

describe("identity assertion verification", () => {
	it("returns a refs-only verified assertion on success", async () => {
		const assertion = createFixtureAssertion(claims(), FIXTURE_SIGNING_KEY);

		const verified = await verifyIdentityAssertion({
			verifier,
			assertion,
			expectation: expectation(),
		});

		expect(verified.subject).toBe("agent:bo");
		expect(verified.scopes).toEqual(["repo:read"]);
		expect(verified.assertionLocator).toBe(assertion.locator);
		expect(JSON.stringify(verified)).not.toContain("signature");
	});

	it("rejects a forged signature", async () => {
		const assertion = createFixtureAssertion(claims(), "some-other-key");

		await expect(
			verifyIdentityAssertion({
				verifier,
				assertion,
				expectation: expectation(),
			}),
		).rejects.toMatchObject({ code: "AUTHMD_ASSERTION_INVALID" });
	});

	it("rejects an expired assertion", async () => {
		const assertion = createFixtureAssertion(
			claims({ exp: "2026-08-08T11:00:00.000Z" }),
			FIXTURE_SIGNING_KEY,
		);

		await expect(
			verifyIdentityAssertion({
				verifier,
				assertion,
				expectation: expectation(),
			}),
		).rejects.toMatchObject({ code: "AUTHMD_ASSERTION_INVALID" });
	});

	it("rejects an assertion minted for another audience", async () => {
		const assertion = createFixtureAssertion(
			claims({ aud: "https://other.example.test/" }),
			FIXTURE_SIGNING_KEY,
		);

		await expect(
			verifyIdentityAssertion({
				verifier,
				assertion,
				expectation: expectation(),
			}),
		).rejects.toMatchObject({ code: "AUTHMD_ASSERTION_INVALID" });
	});

	it("rejects an assertion from an unexpected issuer", async () => {
		const assertion = createFixtureAssertion(
			claims({ iss: "https://evil.example.test/" }),
			FIXTURE_SIGNING_KEY,
		);

		await expect(
			verifyIdentityAssertion({
				verifier,
				assertion,
				expectation: expectation(),
			}),
		).rejects.toMatchObject({ code: "AUTHMD_ASSERTION_INVALID" });
	});

	it("rejects an assertion bound to a different registration", async () => {
		const assertion = createFixtureAssertion(
			claims({ registration_ref: "reg_other" }),
			FIXTURE_SIGNING_KEY,
		);

		await expect(
			verifyIdentityAssertion({
				verifier,
				assertion,
				expectation: expectation(),
			}),
		).rejects.toMatchObject({ code: "AUTHMD_ASSERTION_INVALID" });
	});

	it("rejects an assertion carrying scopes beyond the authorized set", async () => {
		const assertion = createFixtureAssertion(
			claims({ scopes: ["repo:read", "admin:all"] }),
			FIXTURE_SIGNING_KEY,
		);

		await expect(
			verifyIdentityAssertion({
				verifier,
				assertion,
				expectation: expectation(),
			}),
		).rejects.toMatchObject({ code: "AUTHMD_SCOPE_WIDENING_DENIED" });
	});
});
