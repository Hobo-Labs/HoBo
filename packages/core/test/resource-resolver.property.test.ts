// Property tests for the resolver parse boundaries.
//
// `parseResolveRequest` enforces the credential law: `credentialRef` is a
// locator, never material, and no property bag may carry a credential-shaped
// key at any depth. The properties below state that as a total claim over
// generated hostile input, plus the one that makes a refusal safe to log — the
// refused value is never echoed back in the message. A refusal that reprints
// the secret has defeated its own purpose.
//
// Determinism: every run is seeded so a failure reproduces exactly.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	CAPABILITY_SLOTS,
	parseResolveOutcome,
	parseResolveRequest,
	RESOLVER_ACTIONS,
	RESOLVER_CONTRACT,
} from "../src/index.js";
import type { JsonObject, JsonValue } from "../src/json.js";

/** Fixed seed: a counterexample found here is reproducible verbatim. */
const SEED = 20260817;
const RUNS = 300;

const MAX_CREDENTIAL_REF_LENGTH = 512;

const CREDENTIAL_KEY_PATTERN =
	/(secret|password|token|credential|private[_-]?key|api[_-]?key)/i;

const CREDENTIAL_BASES = [
	"secret",
	"password",
	"token",
	"credential",
	"private_key",
	"private-key",
	"privatekey",
	"api_key",
	"api-key",
	"apikey",
] as const;

const safeKeyArb = fc
	.stringMatching(/^[a-z][a-z0-9]{0,6}$/u)
	.filter((key) => key.length > 0 && !CREDENTIAL_KEY_PATTERN.test(key));

const jsonScalarArb = fc.oneof(
	fc.constant(null),
	fc.boolean(),
	fc.integer(),
	fc.double({ noNaN: true, noDefaultInfinity: true }),
	fc.string(),
);

const jsonValueArb: fc.Arbitrary<unknown> = fc.letrec<{ value: JsonValue }>(
	(tie) => ({
		value: fc.oneof(
			{ maxDepth: 3 },
			jsonScalarArb,
			fc.array(tie("value"), { maxLength: 3 }),
			fc.dictionary(safeKeyArb, tie("value"), { maxKeys: 4 }),
		),
	}),
).value;

const safeBagArb = fc.dictionary(safeKeyArb, jsonValueArb, { maxKeys: 5 });

const credentialKeyArb = fc
	.tuple(
		fc.constantFrom(...CREDENTIAL_BASES),
		fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }),
		fc.stringMatching(/^[a-z]{0,4}$/u),
		fc.stringMatching(/^[a-z]{0,4}$/u),
	)
	.map(([base, casing, prefix, suffix]) => {
		const cased = [...base]
			.map((char, index) =>
				casing[index % casing.length] === true ? char.toUpperCase() : char,
			)
			.join("");
		return `${prefix}${cased}${suffix}`;
	});

const hiddenCredentialBagArb = fc
	.tuple(
		credentialKeyArb,
		fc.array(fc.tuple(safeKeyArb, fc.boolean()), { maxLength: 4 }),
		jsonScalarArb,
		safeBagArb,
	)
	.map(([credentialKey, wrappers, payload, siblings]) => {
		let node: JsonValue = { ...siblings, [credentialKey]: payload };
		for (const [key, insideArray] of wrappers) {
			node = insideArray ? { [key]: [null, node] } : { [key]: node };
		}
		// SAFETY: assertion required at this I/O or test boundary.
		return { credentialKey, bag: node as JsonObject };
	});

const refArb = fc.record({
	slot: fc.constantFrom(...CAPABILITY_SLOTS),
	productId: fc.constantFrom("aws.rds-postgres", "gcp/cloud-sql", "fly.pg"),
	logicalId: fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,16}$/u),
});

/** A high-entropy marker so "was it echoed?" is not a coincidence question. */
const markerArb = fc.stringMatching(/^[A-Za-z0-9]{16,24}$/u);

/** Locators the grammar must accept: `scheme://path`, no `@`, under the cap. */
const acceptedLocatorArb = fc
	.tuple(
		fc.stringMatching(/^[a-z][a-z0-9+.-]{0,8}$/u),
		fc.stringMatching(/^[A-Za-z0-9\-._~:/[\]!$&'()*+,;=]{1,80}$/u),
	)
	.map(([scheme, path]) => `${scheme}://${path}`)
	.filter((value) => value.length <= MAX_CREDENTIAL_REF_LENGTH);

/**
 * Locators the grammar must refuse, each carrying `marker` as the material a
 * leaky refusal would echo. Every shape here is one the module names:
 * whitespace, a control character, embedded userinfo, a PEM block, an
 * Authorization scheme prefix, a JWT, an inline credential query parameter, and
 * a value past the length bound.
 */
const refusedLocatorArb = fc
	.tuple(
		markerArb,
		fc.constantFrom(
			"whitespace",
			"control",
			"userinfo",
			"pem",
			"authScheme",
			"jwt",
			"inlineQuery",
			"tooLong",
		),
		fc.constantFrom(" ", "\t", "\n", "\r", "\u000b", "\u000c", "\u00a0"),
	)
	.map(([marker, layout, space]) => {
		switch (layout) {
			case "whitespace":
				return { marker, value: `vault://kv/${marker}${space}next` };
			case "control":
				return { marker, value: `vault://kv/${marker}\u0007next` };
			case "userinfo":
				return { marker, value: `vault://${marker}@evil.example.com/kv` };
			case "pem":
				return { marker, value: `-----BEGIN-PRIVATE-KEY-----${marker}` };
			case "authScheme":
				return { marker, value: `Bearer ${marker}` };
			case "jwt":
				return { marker, value: `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIx.${marker}` };
			case "inlineQuery":
				return { marker, value: `vault://kv/db?token=${marker}` };
			default:
				return {
					marker,
					value: `vault://kv/${marker.repeat(
						Math.ceil((MAX_CREDENTIAL_REF_LENGTH + 32) / marker.length),
					)}`,
				};
		}
	});

function request(overrides: JsonObject): JsonObject {
	return {
		ref: { slot: "data", productId: "aws.rds-postgres", logicalId: "primary" },
		desired: {},
		credentialRef: "vault://kv/hobo/aws",
		...overrides,
	};
}

function outcome(overrides: JsonObject): JsonObject {
	return {
		contract: RESOLVER_CONTRACT,
		action: "create",
		physicalId: "arn:aws:rds:db-1",
		outputs: {},
		...overrides,
	};
}

function refusalOf(fn: () => JsonValue) {
	try {
		fn();
		return { code: "NO_THROW", message: "" };
	} catch (error) {
		// SAFETY: assertion required at this I/O or test boundary.
		const failure = error as { code?: string; message?: string };
		return { code: failure.code ?? "NO_CODE", message: failure.message ?? "" };
	}
}

describe("the resolver credential law holds over generated input", () => {
	it("accepts any well-formed scheme://path locator under the cap", () => {
		fc.assert(
			fc.property(refArb, acceptedLocatorArb, (ref, credentialRef) => {
				const parsed = parseResolveRequest(request({ ref, credentialRef }));
				expect(parsed.credentialRef).toBe(credentialRef);
			}),
			{ seed: SEED, numRuns: RUNS },
		);
	});

	it("refuses every value-shaped credentialRef", () => {
		fc.assert(
			fc.property(refusedLocatorArb, ({ value }) => {
				const { code, message } = refusalOf(() =>
					parseResolveRequest(request({ credentialRef: value })),
				);
				expect(code).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");
				// The refusal names the fix without naming the material.
				expect(message).toContain("credentialRef");
				expect(message).toContain("locator");
			}),
			{ seed: SEED, numRuns: RUNS },
		);
	});

	it("never echoes the refused value in the refusal message", () => {
		fc.assert(
			fc.property(refusedLocatorArb, ({ marker, value }) => {
				const { message } = refusalOf(() =>
					parseResolveRequest(request({ credentialRef: value })),
				);
				expect(message).not.toContain(marker);
				expect(message).not.toContain(value);
			}),
			{ seed: SEED, numRuns: RUNS },
		);
	});

	it("screens credential keys at any depth in desired and observed", () => {
		fc.assert(
			fc.property(
				hiddenCredentialBagArb,
				fc.boolean(),
				({ credentialKey, bag }, inObserved) => {
					const overrides = inObserved
						? { desired: {}, observed: bag }
						: { desired: bag };
					const { code, message } = refusalOf(() =>
						parseResolveRequest(request(overrides)),
					);
					expect(code).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");
					expect(message).toContain(credentialKey);
					expect(message).toContain(inObserved ? "observed" : "desired");
				},
			),
			{ seed: SEED, numRuns: RUNS },
		);
	});

	it("screens credential keys at any depth in resolver outputs", () => {
		fc.assert(
			fc.property(
				hiddenCredentialBagArb,
				fc.constantFrom(...RESOLVER_ACTIONS),
				({ credentialKey, bag }, action) => {
					const { code, message } = refusalOf(() =>
						parseResolveOutcome(outcome({ action, outputs: bag })),
					);
					expect(code).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");
					expect(message).toContain(credentialKey);
					expect(message).toContain("outputs");
				},
			),
			{ seed: SEED, numRuns: RUNS },
		);
	});

	it("is idempotent: re-parsing an accepted request is a fixed point", () => {
		fc.assert(
			fc.property(
				refArb,
				acceptedLocatorArb,
				safeBagArb,
				fc.option(safeBagArb, { nil: undefined }),
				(ref, credentialRef, desired, observed) => {
					const once = parseResolveRequest(
						request({ ref, credentialRef, desired, observed }),
					);
					expect(parseResolveRequest(once)).toStrictEqual(once);
				},
			),
			{ seed: SEED, numRuns: RUNS },
		);
	});

	it("is idempotent for outcomes as well", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...RESOLVER_ACTIONS),
				safeBagArb,
				fc.array(fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,23}$/u), {
					maxLength: 4,
				}),
				(action, outputs, diagnostics) => {
					const once = parseResolveOutcome(
						outcome({ action, outputs, diagnostics }),
					);
					expect(parseResolveOutcome(once)).toStrictEqual(once);
				},
			),
			{ seed: SEED, numRuns: RUNS },
		);
	});
});
