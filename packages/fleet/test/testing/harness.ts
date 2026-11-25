import { expect, it } from "vitest";
import type { ConformanceAssertion } from "../../src/testing/conformance/assertion.js";

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
