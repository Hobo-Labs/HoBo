// Property tests for `parseYardBindings`.
//
// The module note calls the row list "a set, not a list": authoring order must
// not survive into the record, because ADR-0151 forbids any ordered or weighted
// scoring and an order that leaks becomes a preference. That is an algebraic
// claim — permutation invariance plus idempotence — and example-based tests can
// only spot-check it. The duplicate and empty-constraint refusals are total
// claims for the same reason: a row set that admits either one is a portability
// lie the planner would act on.
//
// The profile grammar is checked against a hand-written recognizer rather than
// against the exported regex, so this test can disagree with the source.
//
// Determinism: every run is seeded so a failure reproduces exactly.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseYardBindings, type YardBindingInput } from "../src/index.js";

/** Fixed seed: a counterexample found here is reproducible verbatim. */
const SEED = 20260817;
const RUNS = 300;

const validProfileArb = fc.stringMatching(
	/^[a-z][a-z0-9-]{0,5}(\.[a-z0-9-]{1,5}){0,2}\/v[1-9][0-9]{0,1}$/u,
);

const idArb = fc.stringMatching(/^[a-z][a-z0-9:._-]{0,10}$/u);

const rowArb: fc.Arbitrary<YardBindingInput> = fc
	.tuple(
		validProfileArb,
		fc.option(idArb, { nil: undefined }),
		fc.option(idArb, { nil: undefined }),
		fc.option(
			fc.array(fc.stringMatching(/^[a-z][a-z0-9-]{0,6}$/u), { maxLength: 3 }),
			{ nil: undefined },
		),
		fc.option(
			fc.dictionary(
				fc.stringMatching(/^[a-z][a-z0-9]{0,5}$/u),
				fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
				{ maxKeys: 3 },
			),
			{ nil: undefined },
		),
	)
	// A row must constrain something; when neither id was drawn, pin productId
	// so this generator only produces rows the boundary can accept.
	.map(([profile, productId, connectivityId, require, properties]) => ({
		profile,
		...(productId === undefined && connectivityId === undefined
			? { productId: "fallback.product" }
			: undefined),
		...(productId !== undefined ? { productId } : undefined),
		...(connectivityId !== undefined ? { connectivityId } : undefined),
		...(require !== undefined ? { require } : undefined),
		...(properties !== undefined ? { properties } : undefined),
	}));

function tripleOf(row: YardBindingInput): string {
	return JSON.stringify([
		row.profile,
		row.productId ?? "",
		row.connectivityId ?? "",
	]);
}

/** Row lists whose (profile, productId, connectivityId) triples are distinct. */
const rowSetArb = fc.uniqueArray(rowArb, {
	minLength: 1,
	maxLength: 6,
	selector: tripleOf,
});

/**
 * The ADR-0151 profile grammar, recognized by hand rather than by reusing the
 * exported regex: `<family>.<path>/v<major>`, lowercase, no leading zero on the
 * major, and no `/` anywhere but the version separator.
 */
function grammarAccepts(value: string): boolean {
	const parts = value.split("/");
	if (parts.length !== 2) return false;
	const head = parts[0] ?? "";
	const version = parts[1] ?? "";
	if (head.length === 0) return false;
	const isLower = (char: string): boolean => char >= "a" && char <= "z";
	const isDigit = (char: string): boolean => char >= "0" && char <= "9";
	if (!isLower(head.charAt(0))) return false;
	for (const segment of head.split(".")) {
		if (segment.length === 0) return false;
		for (const char of segment) {
			if (!isLower(char) && !isDigit(char) && char !== "-") return false;
		}
	}
	if (version.charAt(0) !== "v") return false;
	const major = version.slice(1);
	if (major.length === 0 || major.charAt(0) === "0") return false;
	for (const char of major) {
		if (!isDigit(char)) return false;
	}
	return true;
}

interface Refusal {
	readonly code: string;
	readonly message: string;
}

function refusalOf(fn: () => void): Refusal {
	try {
		fn();
		return { code: "NO_THROW", message: "" };
	} catch (error) {
		// SAFETY: `const failure = error as { code?: string; message?: string };` is required at this I/O or test boundary.
		const failure = error as { code?: string; message?: string };
		return { code: failure.code ?? "NO_CODE", message: failure.message ?? "" };
	}
}

describe("parseYardBindings treats rows as a set", () => {
	it("is permutation invariant: shuffling the input keeps the record", () => {
		fc.assert(
			fc.property(
				rowSetArb.chain((rows) =>
					fc.tuple(
						fc.constant(rows),
						fc.shuffledSubarray(rows, {
							minLength: rows.length,
							maxLength: rows.length,
						}),
					),
				),
				([rows, shuffled]) => {
					expect(parseYardBindings(shuffled)).toStrictEqual(
						parseYardBindings(rows),
					);
				},
			),
			{ seed: SEED, numRuns: RUNS },
		);
	});

	it("is idempotent: re-parsing an accepted record is a fixed point", () => {
		fc.assert(
			fc.property(rowSetArb, (rows) => {
				const once = parseYardBindings(rows);
				expect(parseYardBindings(once)).toStrictEqual(once);
			}),
			{ seed: SEED, numRuns: RUNS },
		);
	});

	it("refuses any repeated (profile, productId, connectivityId) triple", () => {
		fc.assert(
			fc.property(
				rowSetArb,
				fc.nat(),
				fc.nat(),
				(rows, pickSeed, insertSeed) => {
					// SAFETY: `const source = rows[pickSeed % rows.length] as YardBindingInput;` is required at this I/O or test boundary.
					const source = rows[pickSeed % rows.length] as YardBindingInput;
					const duplicate: YardBindingInput = {
						...source,
						require: ["a-different-require"],
					};
					const withDuplicate = [...rows];
					withDuplicate.splice(insertSeed % (rows.length + 1), 0, duplicate);
					const { code, message } = refusalOf(() =>
						parseYardBindings(withDuplicate),
					);
					expect(code).toBe("YARD_BINDING_DUPLICATE");
					// A refusal that does not name the colliding row is not a fix.
					expect(message).toContain(source.profile);
				},
			),
			{ seed: SEED, numRuns: RUNS },
		);
	});

	it("refuses a row that constrains neither product nor connectivity", () => {
		fc.assert(
			fc.property(validProfileArb, rowSetArb, fc.nat(), (profile, rows, at) => {
				const empty: YardBindingInput = { profile };
				const withEmpty = [...rows];
				withEmpty.splice(at % (rows.length + 1), 0, empty);
				const { code, message } = refusalOf(() => parseYardBindings(withEmpty));
				expect(code).toBe("YARD_BINDING_EMPTY_CONSTRAINT");
				expect(message).toContain(profile);
				expect(message).toContain("productId");
			}),
			{ seed: SEED, numRuns: RUNS },
		);
	});

	it("accepts exactly the profiles the ADR-0151 grammar admits", () => {
		const profileArb = fc.oneof(
			validProfileArb,
			// Strings that straddle the grammar boundary in every direction.
			fc.string({
				unit: fc.constantFrom(..."abz09-._/vV0"),
				maxLength: 12,
			}),
			fc
				.tuple(validProfileArb, fc.constantFrom("", "/", ".", "-", "V", "0"))
				.map(([profile, suffix]) => `${profile}${suffix}`),
			fc
				.tuple(fc.constantFrom("", "/", ".", "-", "1", "A"), validProfileArb)
				.map(([prefix, profile]) => `${prefix}${profile}`),
		);
		let acceptedCount = 0;
		let refusedCount = 0;
		fc.assert(
			fc.property(profileArb, (profile) => {
				const { code, message } = refusalOf(() =>
					parseYardBindings([{ profile, productId: "aws:rds-postgres" }]),
				);
				if (grammarAccepts(profile)) {
					acceptedCount += 1;
					expect(code).toBe("NO_THROW");
				} else {
					refusedCount += 1;
					expect(code).toBe("YARD_BINDING_PROFILE_INVALID");
					expect(message).toContain(JSON.stringify(profile));
				}
			}),
			{ seed: SEED, numRuns: RUNS },
		);
		// Neither branch may be vacuous, or the property proves nothing.
		expect(acceptedCount).toBeGreaterThan(0);
		expect(refusedCount).toBeGreaterThan(0);
	});
});
