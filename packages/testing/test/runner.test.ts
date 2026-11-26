import { describe, expect, it } from "vitest";
import {
	bindHarnessLifecycle,
	createNodeTestRunnerAdapter,
	createTestHarness,
	createVitestRunnerAdapter,
	detectRunner,
	parseRunnerAdapter,
	requireRunner,
	TestHarnessError,
} from "../src/index.js";
import { fakeBindle, recordingRunner } from "./fixtures.js";

const noop = (): void => {};

describe("runner detection", () => {
	it.each([
		[{ VITEST: "true" }, "vitest"],
		[{ VITEST_WORKER_ID: "0" }, "vitest"],
		[{ NODE_TEST_CONTEXT: "child-v8" }, "node:test"],
	])("detects %o as %s", (env, expected) => {
		expect(detectRunner(env)).toBe(expected);
	});

	it("returns null when nothing identifies a runner", () => {
		expect(detectRunner({})).toBeNull();
	});

	it("fails closed with remediation when no runner is detected", () => {
		try {
			requireRunner({});
			expect.unreachable("expected a refusal");
		} catch (error) {
			expect((error as TestHarnessError).code).toBe(
				"HARNESS_RUNNER_UNDETECTED",
			);
			expect((error as TestHarnessError).remediation).toContain("runner");
		}
	});

	it("refuses to build a harness when the runner cannot be detected", () => {
		expect(() => createTestHarness({}, { env: {} })).toThrow(TestHarnessError);
	});
});

describe("runner adapters", () => {
	it("maps a vitest module onto the adapter shape", () => {
		const adapter = createVitestRunnerAdapter({
			beforeAll: noop,
			afterAll: noop,
			beforeEach: noop,
			afterEach: noop,
			it: noop,
		});
		expect(adapter.id).toBe("vitest");
		expect(Object.isFrozen(adapter)).toBe(true);
	});

	it("maps node:test's before/after onto beforeAll/afterAll", () => {
		let beforeCalled = false;
		const adapter = createNodeTestRunnerAdapter({
			before: () => {
				beforeCalled = true;
			},
			after: noop,
			beforeEach: noop,
			afterEach: noop,
			test: noop,
		});
		expect(adapter.id).toBe("node:test");
		adapter.beforeAll(noop);
		expect(beforeCalled).toBe(true);
	});

	it.each([
		[{ beforeAll: noop }, "a vitest module missing afterAll"],
		[{}, "an empty module"],
	])("refuses %o (%s)", (module) => {
		expect(() =>
			createVitestRunnerAdapter(
				module as Parameters<typeof createVitestRunnerAdapter>[0],
			),
		).toThrow(TestHarnessError);
	});

	it.each([
		[null, "null"],
		[{}, "an object with no hooks"],
		[
			{
				beforeAll: noop,
				afterAll: noop,
				beforeEach: noop,
				afterEach: noop,
				test: noop,
			},
			"an adapter with no id",
		],
	])("parseRunnerAdapter refuses %o (%s)", (value) => {
		try {
			parseRunnerAdapter(value);
			expect.unreachable("expected a refusal");
		} catch (error) {
			expect((error as TestHarnessError).code).toBe("HARNESS_RUNNER_INVALID");
		}
	});

	it("accepts a supplied adapter in place of detection", () => {
		const { adapter } = recordingRunner();
		expect(() =>
			createTestHarness({ runner: adapter }, { env: {} }),
		).not.toThrow();
	});
});

describe("bindHarnessLifecycle", () => {
	it("registers deploy in beforeAll and destroy in afterAll", async () => {
		const runner = recordingRunner();
		const harness = createTestHarness({ runner: runner.adapter }, { env: {} });
		const bindle = fakeBindle();
		bindHarnessLifecycle(runner.adapter, harness, bindle);
		expect(runner.calls).toEqual(["beforeAll", "afterAll"]);
		await runner.run("beforeAll");
		await runner.run("afterAll");
	});
});
