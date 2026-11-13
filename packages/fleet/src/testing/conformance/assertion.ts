/**
 * What every conformance suite is made of (design §7.3, L29): a list of named
 * assertions, each a check run against what the adapter's `make` builds.
 *
 * `registerSuite` turns a list into one vitest `describe` with one `it` per
 * assertion, which is what the exported `run*Conformance` functions do. The
 * lists themselves stay private to this directory: the package's own tests run
 * them directly to prove that each assertion fails a double broken in exactly
 * its way (O39).
 */
import { describe, it } from "vitest";

/** One named check of a conformance suite. `check` throws when the adapter breaks the contract. */
export type ConformanceAssertion<Make> = Readonly<{
	name: string;
	check(make: Make): Promise<void>;
}>;

/** Thrown by a failing assertion; the message names what the adapter did wrong. */
export class ConformanceFailure extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConformanceFailure";
	}
}

/** Registers `assertions` as one vitest suite, one test per assertion, each against `make`. */
export function registerSuite<Make>(
	title: string,
	assertions: readonly ConformanceAssertion<Make>[],
	make: Make,
	timeoutMs: number,
): void {
	describe(title, () => {
		for (const assertion of assertions)
			it(assertion.name, () => assertion.check(make), timeoutMs);
	});
}

/** Fails the running assertion with `message` unless `condition` holds. */
export function ensure(condition: boolean, message: string): asserts condition {
	if (!condition) throw new ConformanceFailure(message);
}

export function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits until `ready` answers true, polling every 5 ms; fails with `message` after `timeoutMs`. */
export async function eventually(
	ready: () => boolean | Promise<boolean>,
	timeoutMs: number,
	message: string,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await ready()) return;
		if (Date.now() > deadline) throw new ConformanceFailure(message);
		await pause(5);
	}
}

/** Runs `action` and answers whether it threw or rejected. */
export async function fails(action: () => Promise<void>): Promise<boolean> {
	try {
		await action();
		return false;
	} catch {
		return true;
	}
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
