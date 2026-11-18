import { TestHarnessError } from "./errors.js";

export const TEST_RUNNERS: readonly string[] = Object.freeze([
	"vitest",
	"node:test",
]);

export type TestRunnerId = "vitest" | "node:test";

export type RunnerHook = (fn: () => void | Promise<void>) => unknown;

export interface RunnerAdapter {
	readonly id: string;
	readonly beforeAll: RunnerHook;
	readonly afterAll: RunnerHook;
	readonly beforeEach: RunnerHook;
	readonly afterEach: RunnerHook;
	readonly test: (name: string, fn: () => void | Promise<void>) => unknown;
}

export interface VitestRunnerModule {
	readonly beforeAll: RunnerHook;
	readonly afterAll: RunnerHook;
	readonly beforeEach: RunnerHook;
	readonly afterEach: RunnerHook;
	readonly it?: (name: string, fn: () => void | Promise<void>) => unknown;
	readonly test?: (name: string, fn: () => void | Promise<void>) => unknown;
}

export interface NodeTestRunnerModule {
	readonly before: RunnerHook;
	readonly after: RunnerHook;
	readonly beforeEach: RunnerHook;
	readonly afterEach: RunnerHook;
	readonly test: (name: string, fn: () => void | Promise<void>) => unknown;
}

function requireFunction(
	value: unknown,
	member: string,
	moduleName: string,
): void {
	if (typeof value !== "function") {
		throw new TestHarnessError(
			"HARNESS_RUNNER_INVALID",
			`the supplied ${moduleName} module has no callable \`${member}\``,
			`import the runner module namespace (\`import * as m from "${moduleName}"\`) and pass it unchanged`,
		);
	}
}

export function createVitestRunnerAdapter(
	module: VitestRunnerModule,
): RunnerAdapter {
	requireFunction(module?.beforeAll, "beforeAll", "vitest");
	requireFunction(module?.afterAll, "afterAll", "vitest");
	requireFunction(module?.beforeEach, "beforeEach", "vitest");
	requireFunction(module?.afterEach, "afterEach", "vitest");
	const test = module.test ?? module.it;
	requireFunction(test, "test", "vitest");
	return Object.freeze({
		id: "vitest",
		beforeAll: module.beforeAll,
		afterAll: module.afterAll,
		beforeEach: module.beforeEach,
		afterEach: module.afterEach,
		test: test as RunnerAdapter["test"],
	});
}

export function createNodeTestRunnerAdapter(
	module: NodeTestRunnerModule,
): RunnerAdapter {
	requireFunction(module?.before, "before", "node:test");
	requireFunction(module?.after, "after", "node:test");
	requireFunction(module?.beforeEach, "beforeEach", "node:test");
	requireFunction(module?.afterEach, "afterEach", "node:test");
	requireFunction(module?.test, "test", "node:test");
	return Object.freeze({
		id: "node:test",
		beforeAll: module.before,
		afterAll: module.after,
		beforeEach: module.beforeEach,
		afterEach: module.afterEach,
		test: module.test,
	});
}

export function parseRunnerAdapter(value: unknown): RunnerAdapter {
	const candidate = value as Partial<RunnerAdapter> | null | undefined;
	if (candidate === null || typeof candidate !== "object") {
		throw new TestHarnessError(
			"HARNESS_RUNNER_INVALID",
			"the `runner` option is not a RunnerAdapter",
			"build one with createVitestRunnerAdapter(...) or createNodeTestRunnerAdapter(...)",
		);
	}
	for (const member of [
		"beforeAll",
		"afterAll",
		"beforeEach",
		"afterEach",
		"test",
	] as const) {
		requireFunction(candidate[member], member, "runner adapter");
	}
	if (typeof candidate.id !== "string" || candidate.id.length === 0) {
		throw new TestHarnessError(
			"HARNESS_RUNNER_INVALID",
			"the `runner` option has no non-empty `id`",
			"build the adapter with createVitestRunnerAdapter(...) or createNodeTestRunnerAdapter(...) so it carries an id",
		);
	}
	return Object.freeze({ ...(candidate as RunnerAdapter) });
}

export type RunnerEnvironment = Readonly<Record<string, string | undefined>>;

export function detectRunner(
	env: RunnerEnvironment = process.env,
): TestRunnerId | null {
	if (
		env.VITEST !== undefined ||
		env.VITEST_WORKER_ID !== undefined ||
		env.VITEST_POOL_ID !== undefined
	) {
		return "vitest";
	}
	if (env.NODE_TEST_CONTEXT !== undefined) return "node:test";
	return null;
}

export function requireRunner(
	env: RunnerEnvironment = process.env,
): TestRunnerId {
	const detected = detectRunner(env);
	if (detected === null) {
		throw new TestHarnessError(
			"HARNESS_RUNNER_UNDETECTED",
			"no supported test runner was detected in the environment",
			'run the suite under Vitest or `node --test`, or pass an explicit adapter: createTestHarness({ runner: createVitestRunnerAdapter(await import("vitest")) })',
		);
	}
	return detected;
}
