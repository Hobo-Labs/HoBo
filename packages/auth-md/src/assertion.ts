/**
 * Identity assertion verification.
 *
 * This package invents no cryptography and ships no JWT/JWKS dependency: the
 * repository has none, so verification is an injected port. HoBo deployments
 * bind a real verifier (JWKS, attestation service, provider STS); tests bind
 * the offline HMAC fixture verifier below. Either way the assertion itself
 * stays inside a `SensitiveRef` — the verifier is the only code that discloses
 * it, and what comes back out is a refs-only `VerifiedAssertion`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { authMdError } from "./errors.js";
import type { MaterialLocator, SensitiveRef } from "./redaction.js";
import { createSensitive, discloseSensitive } from "./redaction.js";
import { materialHandle } from "./registration.js";
import type {
	Audience,
	HttpsUrl,
	Instant,
	RegistrationRef,
	Scope,
	SessionBinding,
} from "./types.js";
import {
	parseHttpsUrl,
	parseInstant,
	parseRegistrationRef,
	parseScopes,
	scopesAddedBy,
} from "./types.js";

export interface AssertionExpectation {
	readonly registrationRef: RegistrationRef;
	readonly binding: SessionBinding;
	readonly issuer: HttpsUrl;
	/** Scopes currently authorized for this principal (pre- or post-claim). */
	readonly allowedScopes: readonly Scope[];
	readonly now: Instant;
}

/** What a verifier hands back. Claims are untrusted until parsed here. */
export type AssertionVerifierResult =
	| {
			readonly status: "verified";
			readonly claims: Readonly<Record<string, unknown>>;
	  }
	| { readonly status: "rejected"; readonly reason: string };

export interface AssertionVerifier {
	readonly id: string;
	verify(input: {
		readonly assertion: SensitiveRef<"identity-assertion">;
		readonly expectation: AssertionExpectation;
	}): Promise<AssertionVerifierResult>;
}

// domain-view: parsed derived type; wire form is IdentityAssertionRecord in data-models/auth_md.proto.
export interface VerifiedAssertion {
	readonly registrationRef: RegistrationRef;
	readonly subject: string;
	readonly issuer: HttpsUrl;
	readonly audience: Audience;
	readonly scopes: readonly Scope[];
	readonly issuedAt: Instant;
	readonly expiresAt: Instant;
	/** Opaque locator for the assertion; never the assertion itself. */
	readonly assertionLocator: MaterialLocator;
}

export async function verifyIdentityAssertion(input: {
	readonly verifier: AssertionVerifier;
	readonly assertion: SensitiveRef<"identity-assertion">;
	readonly expectation: AssertionExpectation;
}): Promise<VerifiedAssertion> {
	const { expectation } = input;
	const result = await input.verifier.verify({
		assertion: input.assertion,
		expectation,
	});

	if (result.status === "rejected") {
		throw authMdError(
			"AUTHMD_ASSERTION_INVALID",
			`assertion rejected by verifier ${input.verifier.id}: ${result.reason}`,
			{
				verifier: input.verifier.id,
				registrationRef: expectation.registrationRef,
			},
		);
	}

	const claims = result.claims;
	const registrationRef = parseRegistrationRef(claims.registration_ref);
	if (registrationRef !== expectation.registrationRef) {
		throw authMdError(
			"AUTHMD_ASSERTION_INVALID",
			"assertion is bound to a different registration",
			{ expected: expectation.registrationRef, actual: registrationRef },
		);
	}

	const issuer = parseHttpsUrl(claims.iss, "iss");
	if (issuer !== expectation.issuer) {
		throw authMdError(
			"AUTHMD_ASSERTION_INVALID",
			"assertion issuer is not the expected authorization server",
			{ expected: expectation.issuer, actual: issuer },
		);
	}

	const audience = claims.aud;
	if (
		typeof audience !== "string" ||
		audience !== expectation.binding.audience
	) {
		throw authMdError(
			"AUTHMD_ASSERTION_INVALID",
			"assertion audience does not match the bound audience",
			{ expected: expectation.binding.audience },
		);
	}

	const subject = claims.sub;
	if (typeof subject !== "string" || subject.length === 0) {
		throw authMdError("AUTHMD_ASSERTION_INVALID", "assertion has no subject");
	}

	const scopes = parseScopes(claims.scopes, "scopes");
	const widened = scopesAddedBy(scopes, expectation.allowedScopes);
	if (widened.length > 0) {
		throw authMdError(
			"AUTHMD_SCOPE_WIDENING_DENIED",
			"assertion carries scopes beyond the authorized set",
			{
				widened: widened.join(" "),
				allowed: expectation.allowedScopes.join(" "),
			},
		);
	}

	const issuedAt = parseInstant(claims.iat, "iat");
	const expiresAt = parseInstant(claims.exp, "exp");
	if (Date.parse(expiresAt) <= Date.parse(expectation.now)) {
		throw authMdError("AUTHMD_ASSERTION_INVALID", "assertion has expired", {
			expiresAt,
			now: expectation.now,
		});
	}

	return Object.freeze({
		registrationRef,
		subject,
		issuer,
		audience: audience as Audience,
		scopes,
		issuedAt,
		expiresAt,
		assertionLocator: input.assertion.locator,
	});
}

export interface FixtureAssertionClaims {
	readonly registration_ref: string;
	readonly sub: string;
	readonly iss: string;
	readonly aud: string;
	readonly scopes: readonly string[];
	readonly iat: string;
	readonly exp: string;
}

/**
 * Offline fixture assertion: HMAC over the canonical claims JSON with a
 * test-only key. Not a credential format — a stand-in so tests can exercise
 * the verify path with zero network and zero committed key material.
 */
export function createFixtureAssertion(
	claims: FixtureAssertionClaims,
	signingKey: string,
): SensitiveRef<"identity-assertion"> {
	const payload = JSON.stringify(claims);
	const signature = createHmac("sha256", signingKey)
		.update(payload, "utf8")
		.digest("hex");
	return createSensitive(
		"identity-assertion",
		JSON.stringify({ payload, signature }),
		materialHandle(claims.registration_ref, claims.iat, signature),
	);
}

export function createFixtureAssertionVerifier(options: {
	readonly signingKey: string;
	readonly id?: string;
}): AssertionVerifier {
	return {
		id: options.id ?? "assertion-verifier:fixture",
		async verify({ assertion }) {
			let envelope: { payload?: unknown; signature?: unknown };
			try {
				envelope = JSON.parse(discloseSensitive(assertion)) as {
					payload?: unknown;
					signature?: unknown;
				};
			} catch {
				return { status: "rejected", reason: "malformed assertion envelope" };
			}
			const { payload, signature } = envelope;
			if (typeof payload !== "string" || typeof signature !== "string") {
				return { status: "rejected", reason: "malformed assertion envelope" };
			}
			const expected = createHmac("sha256", options.signingKey)
				.update(payload, "utf8")
				.digest("hex");
			const provided = Buffer.from(signature, "utf8");
			const computed = Buffer.from(expected, "utf8");
			if (
				provided.length !== computed.length ||
				!timingSafeEqual(provided, computed)
			) {
				return { status: "rejected", reason: "signature mismatch" };
			}
			try {
				return {
					status: "verified",
					claims: JSON.parse(payload) as Readonly<Record<string, unknown>>,
				};
			} catch {
				return { status: "rejected", reason: "malformed assertion claims" };
			}
		},
	};
}
