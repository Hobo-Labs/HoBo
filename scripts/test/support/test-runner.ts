export interface TestRunner {
	describe(name: string, fn: () => void | Promise<void>): void;
	it(name: string, fn: () => void | Promise<void>): void;
	it(
		name: string,
		options: { timeout: number },
		fn: () => void | Promise<void>,
	): void;
	afterAll(fn: () => void | Promise<void>): void;
}

export async function testRunner(): Promise<TestRunner> {
	if (process.env.VITEST) return await import("vitest");
	const { after, describe, it } = await import("node:test");
	return { describe, it, afterAll: after };
}
