import fc from "fast-check";
import { expect, it } from "vitest";
import { createInMemoryEventStore } from "../../src/replay/store.js";
import { createWorkflowEngine, defineWorkflow } from "../../src/workflow.js";

interface CyclicResult {
	self?: CyclicResult;
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

it("returns the recorded result on completion and after a restart for generated JSON", async () => {
	await fc.assert(
		fc.asyncProperty(fc.json(), async (json) => {
			const value = JSON.parse(json);
			const wf = defineWorkflow({ name: "result-snapshot", run: () => value });
			const engine = createWorkflowEngine();
			const first = await engine.start(wf, {}, { runId: "terminal" });
			expect(first.result).toEqual(value);
			expect(await engine.resume(wf, "terminal", {})).toEqual(first);
		}),
		{ seed: 151942, numRuns: 150 },
	);
});

it("replays generated step results without rerunning the step", async () => {
	await fc.assert(
		fc.asyncProperty(fc.json(), async (json) => {
			const value = JSON.parse(json);
			let crash = true;
			let calls = 0;
			let firstResult: unknown;
			const wf = defineWorkflow({
				name: "step-snapshot",
				async run(ctx) {
					const result = await ctx.step("read", () => {
						calls++;
						return value;
					});
					if (crash) {
						firstResult = result;
						crash = false;
						throw new Error("host stopped");
					}
					return result;
				},
			});
			const engine = createWorkflowEngine();
			await expect(engine.start(wf, {}, { runId: "step" })).rejects.toThrow(
				"host stopped",
			);
			expect((await engine.resume(wf, "step", {})).result).toEqual(firstResult);
			expect(calls).toBe(1);
		}),
		{ seed: 151943, numRuns: 150 },
	);
});

it.each([
	"run.Completed",
	"run.StepCompleted",
] as const)("captures %s before its asynchronous journal write", async (eventType) => {
	const base = createInMemoryEventStore();
	const entered = deferred();
	const release = deferred();
	const store = {
		...base,
		async append(event: Parameters<typeof base.append>[0], expected?: number) {
			if (event.type === eventType) {
				entered.resolve();
				await release.promise;
			}
			return base.append(event, expected);
		},
	};
	const value = { nested: { message: "before" } };
	const wf = defineWorkflow({
		name: "detached-result",
		run: (ctx) =>
			eventType === "run.StepCompleted" ? ctx.step("read", () => value) : value,
	});
	const engine = createWorkflowEngine({ store });
	const running = engine.start(wf, {}, { runId: "detached" });
	await entered.promise;
	value.nested.message = "after";
	release.resolve();
	const first = await running;
	expect(first.result).toEqual({ nested: { message: "before" } });
	expect(await engine.resume(wf, "detached", {})).toEqual(first);
});

it.each([
	"workflow",
	"step",
] as const)("records an unreproducible %s result as a stable failure", async (kind) => {
	const cycle: CyclicResult = {};
	cycle.self = cycle;
	const shared = { value: 1 };
	let getterCalls = 0;
	const getter = Object.defineProperty({}, "value", {
		enumerable: true,
		get() {
			getterCalls++;
			return 1;
		},
	});
	const invalid = [
		NaN,
		Infinity,
		-0,
		1n,
		new Date(0),
		new Map(),
		{ omitted: undefined },
		Array(1),
		cycle,
		{ first: shared, second: shared },
		Object.freeze({ value: 1 }),
		getter,
		new Proxy({ value: 1 }, {}),
	];
	for (const value of invalid) {
		let calls = 0;
		const wf = defineWorkflow({
			name: "invalid-result",
			run: (ctx) => {
				calls++;
				return kind === "step" ? ctx.step("read", () => value) : value;
			},
		});
		const engine = createWorkflowEngine();
		const first = await engine.start(wf, {}, { runId: "invalid" });
		expect(first.status).toBe("failed");
		expect(first.error).toMatchObject({
			code: "workflow.failed",
			message: "workflow result must be JSON-normalized",
		});
		expect(first.error?.step).toBe(kind === "step" ? "read" : undefined);
		expect(await engine.resume(wf, "invalid", {})).toEqual(first);
		expect(calls).toBe(1);
		const types = (await engine.journal("invalid")).map((event) => event.type);
		expect(types).not.toContain("run.Completed");
		if (kind === "step") {
			expect(types).toContain("run.StepFailed");
			expect(types).not.toContain("run.StepCompleted");
		}
	}
	expect(getterCalls).toBe(0);
});

it.each([
	"workflow",
	"step",
] as const)("preserves an undefined %s result", async (kind) => {
	const wf = defineWorkflow({
		name: "void-result",
		run: (ctx) =>
			kind === "step" ? ctx.step("void", () => undefined) : undefined,
	});
	const engine = createWorkflowEngine();
	const first = await engine.start(wf, {}, { runId: "void" });
	expect(first.status).toBe("completed");
	expect(first.result).toBeUndefined();
	expect(await engine.resume(wf, "void", {})).toEqual(first);
});
