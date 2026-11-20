import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
	always,
	atom,
	check,
	eventually,
	implies,
	next,
	not,
	once,
	within,
} from "../../src/ceremony-spec/ltl.js";

// SPEC: the finite-trace temporal logic the ceremony's properties are
// written in. Its laws are checked as properties over random traces, so the
// checker itself is not the thing that guesses.

const is = (value: number) => atom<number>((event) => event === value);
const trace = fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 12 });

describe("SPEC LTLf: the operators' laws", () => {
	it("always p ≡ ¬eventually ¬p", () => {
		fc.assert(
			fc.property(trace, (t) => {
				const p = is(1);
				expect(always(p)(t, 0)).toBe(!eventually(not(p))(t, 0));
			}),
		);
	});

	it("eventually p ≡ p ∨ next eventually p (on non-empty traces)", () => {
		fc.assert(
			fc.property(trace, (t) => {
				fc.pre(t.length > 0);
				const p = is(2);
				expect(eventually(p)(t, 0)).toBe(p(t, 0) || next(eventually(p))(t, 0));
			}),
		);
	});

	it("within n p implies eventually p, and within (len) p ≡ eventually p", () => {
		fc.assert(
			fc.property(trace, fc.nat(12), (t, n) => {
				const p = is(3);
				if (within(n, p)(t, 0)) expect(eventually(p)(t, 0)).toBe(true);
				expect(within(t.length, p)(t, 0)).toBe(eventually(p)(t, 0));
			}),
		);
	});

	it("once p at the last position ≡ p somewhere in the trace", () => {
		fc.assert(
			fc.property(trace, (t) => {
				fc.pre(t.length > 0);
				const p = is(0);
				expect(once(p)(t, t.length - 1)).toBe(eventually(p)(t, 0));
			}),
		);
	});

	it("an invariant names its first violation as the counterexample", () => {
		// "every 2 has a 1 before it"
		const property = {
			name: "1 before 2",
			kind: "invariant" as const,
			invariant: implies(is(2), once(is(1))),
		};
		expect(check(property, [0, 1, 2, 2])).toEqual({
			property: "1 before 2",
			holds: true,
		});
		expect(check(property, [0, 2, 1, 2])).toEqual({
			property: "1 before 2",
			holds: false,
			at: 1,
			event: 2,
		});
	});
});
