/**
 * Runs a conformance suite's assertions directly, outside vitest's own
 * registration, so a test can say exactly which assertions a double fails.
 */
import { expect, it } from "vitest";
import type { ConformanceAssertion } from "../../src/testing/conformance/assertion.js";

/** The names of the assertions that fail against `make`, in suite order. */
export async function failingAssertions<Make>(
	assertions: readonly ConformanceAssertion<Make>[],
	make: Make,
): Promise<string[]> {
	const failing: string[] = [];
	for (const assertion of assertions) {
		try {
			await assertion.check(make);
		} catch {
			failing.push(assertion.name);
		}
	}
	return failing;
}

/**
 * One test per assertion: the double broken in exactly that assertion's way
 * fails that assertion and no other. Also checks that every assertion has its
 * broken double and every double names an assertion.
 */
export function eachAssertionCatchesItsBreak<Make>(
	assertions: readonly ConformanceAssertion<Make>[],
	broken: ReadonlyMap<string, Make>,
	timeoutMs = 30_000,
): void {
	it("has one broken double per assertion", () => {
		expect([...broken.keys()].sort()).toEqual(
			assertions.map((assertion) => assertion.name).sort(),
		);
	});
	for (const assertion of assertions) {
		it(
			`a double broken for "${assertion.name}" fails exactly that assertion`,
			async () => {
				const make = broken.get(assertion.name);
				expect(make, `no broken double for ${assertion.name}`).toBeDefined();
				if (make === undefined) return;
				expect(await failingAssertions(assertions, make)).toEqual([
					assertion.name,
				]);
			},
			timeoutMs,
		);
	}
}
