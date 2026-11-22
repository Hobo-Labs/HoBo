import { describe, it } from "vitest";

export type ConformanceAssertion<Make> = Readonly<{
	name: string;
	check(make: Make): Promise<void>;
}>;

export class ConformanceFailure extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConformanceFailure";
	}
}

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

export function ensure(condition: boolean, message: string): asserts condition {
	if (!condition) throw new ConformanceFailure(message);
}

export function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

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
