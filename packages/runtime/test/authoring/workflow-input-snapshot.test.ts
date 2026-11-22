import fc from "fast-check";
import { expect, it } from "vitest";
import { createInMemoryEventStore } from "../../src/replay/store.js";
import { createWorkflowEngine, defineWorkflow } from "../../src/workflow.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

interface CyclicInput {
	self?: CyclicInput;
}

it.each([
	"start",
	"resume",
] as const)("isolates %s input from later caller edits", async (mode) => {
	const entered = deferred();
	const release = deferred();
	let stop = mode === "resume";
	const wf = defineWorkflow({
		name: "input-snapshot",
		async run(ctx, args: { target: { name: string }; labels: string[] }) {
			if (stop) {
				stop = false;
				throw new Error("host stopped");
			}
			return ctx.step("apply", async () => {
				entered.resolve();
				await release.promise;
				return { name: args.target.name, labels: args.labels };
			});
		},
	});
	const engine = createWorkflowEngine();
	const input = { target: { name: "original" }, labels: ["first"] };
	if (mode === "resume")
		await expect(
			engine.start(wf, input, { runId: "snapshot" }),
		).rejects.toThrow("host stopped");
	const running =
		mode === "start"
			? engine.start(wf, input, { runId: "snapshot" })
			: engine.resume(wf, "snapshot", input);
	await entered.promise;
	input.target.name = "changed";
	input.labels.push("changed");
	release.resolve();
	expect((await running).result).toEqual({
		name: "original",
		labels: ["first"],
	});
	const started = (await engine.journal("snapshot")).find(
		(event) => event.type === "run.Started",
	);
	expect(started?.data).toMatchObject({
		args: { target: { name: "original" }, labels: ["first"] },
	});
});

it("captures input before the initial journal append can wait", async () => {
	const base = createInMemoryEventStore();
	const entered = deferred();
	const release = deferred();
	const store = {
		...base,
		async append(event: Parameters<typeof base.append>[0], expected?: number) {
			if (event.type === "run.Started") {
				entered.resolve();
				await release.promise;
			}
			return base.append(event, expected);
		},
	};
	const wf = defineWorkflow({
		name: "before-append",
		run: (_ctx, args: { name: string }) => args.name,
	});
	const engine = createWorkflowEngine({ store });
	const input = { name: "original" };
	const running = engine.start(wf, input, { runId: "before-append" });
	await entered.promise;
	input.name = "changed";
	release.resolve();
	await expect(running).resolves.toMatchObject({ result: "original" });
});

it("preserves generated input values while the caller edits its object", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.string({ maxLength: 20 }),
			fc.string({ maxLength: 20 }),
			async (original, changed) => {
				const entered = deferred();
				const release = deferred();
				const wf = defineWorkflow({
					name: "generated-input-snapshot",
					async run(ctx, args: { nested: { value: string } }) {
						return ctx.step("read", async () => {
							entered.resolve();
							await release.promise;
							return args.nested.value;
						});
					},
				});
				const engine = createWorkflowEngine();
				const input = { nested: { value: original } };
				const running = engine.start(wf, input, { runId: "generated" });
				await entered.promise;
				input.nested.value = changed;
				release.resolve();
				expect((await running).result).toBe(original);
			},
		),
		{ seed: 614606, numRuns: 40 },
	);
});

it("rejects inputs that cannot be reproduced from the JSON journal", async () => {
	let calls = 0;
	const wf = defineWorkflow({
		name: "non-json-input",
		run: () => {
			calls++;
			return "ok";
		},
	});
	const engine = createWorkflowEngine();
	const values = [
		undefined,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		-0,
		new Date("2026-01-01T00:00:00Z"),
		{ omitted: undefined },
		{ count: BigInt(1) },
		new Map([["a", 1]]),
	];
	for (const [index, value] of values.entries()) {
		await expect(
			engine.start(wf, value, { runId: `invalid-${index}` }),
		).rejects.toThrow("workflow input must be JSON-normalized");
		expect(await engine.journal(`invalid-${index}`)).toEqual([]);
		await expect(engine.resume(wf, "missing", value)).rejects.toThrow(
			"workflow input must be JSON-normalized",
		);
	}
	expect(calls).toBe(0);
});

it("does not resume a null-bound run with an undefined input", async () => {
	let calls = 0;
	const wf = defineWorkflow({
		name: "null-input",
		run: () => {
			calls++;
			return null;
		},
	});
	const engine = createWorkflowEngine();
	await engine.start(wf, null, { runId: "null-input" });
	await expect(engine.resume(wf, "null-input", undefined)).rejects.toThrow(
		"workflow input must be JSON-normalized",
	);
	expect(calls).toBe(1);
});

it("refuses shared references and cycles before any workflow work", async () => {
	const shared = { count: 1 };
	const cycle: CyclicInput = {};
	cycle.self = cycle;
	const engine = createWorkflowEngine();
	let calls = 0;
	const wf = defineWorkflow({
		name: "input-references",
		run: () => {
			calls++;
			return null;
		},
	});
	for (const [index, value] of [
		{ left: shared, right: shared },
		cycle,
	].entries()) {
		await expect(
			engine.start(wf, value, { runId: `references-${index}` }),
		).rejects.toThrow("workflow input must be JSON-normalized");
		expect(await engine.journal(`references-${index}`)).toEqual([]);
	}
	expect(calls).toBe(0);
});

it("refuses hidden properties, accessors and nonstandard descriptors", async () => {
	let getterCalls = 0;
	const hidden = Object.defineProperty({}, "secret", {
		value: 1,
		writable: true,
		configurable: true,
	});
	const getter = Object.defineProperty({}, "value", {
		enumerable: true,
		get() {
			getterCalls++;
			return 1;
		},
	});
	const hiddenToJson = Object.defineProperty({}, "toJSON", {
		get() {
			getterCalls++;
			return () => ({});
		},
	});
	const symbol = { [Symbol("hidden")]: 1 };
	const hiddenSymbol = Object.defineProperty({}, Symbol("hidden"), {
		value: 1,
		writable: true,
		configurable: true,
	});
	const readonly = Object.defineProperty({}, "value", {
		value: 1,
		enumerable: true,
		configurable: true,
		writable: false,
	});
	const nonconfigurable = Object.defineProperty({}, "value", {
		value: 1,
		enumerable: true,
		writable: true,
	});
	const sparse = Array(2);
	const extended = Object.assign([1], { extra: true });
	const values = [
		hidden,
		getter,
		hiddenToJson,
		symbol,
		hiddenSymbol,
		readonly,
		nonconfigurable,
		Object.freeze({ value: 1 }),
		Object.preventExtensions({ value: 1 }),
		sparse,
		extended,
	];
	const wf = defineWorkflow({ name: "input-descriptors", run: () => null });
	const engine = createWorkflowEngine();
	for (const [index, value] of values.entries()) {
		await expect(
			engine.start(wf, value, { runId: `descriptors-${index}` }),
		).rejects.toThrow("workflow input must be JSON-normalized");
		expect(await engine.journal(`descriptors-${index}`)).toEqual([]);
	}
	expect(getterCalls).toBe(0);
});

it("rejects proxies without invoking traps", async () => {
	let traps = 0;
	const proxy = new Proxy(
		{ value: 1 },
		{
			get() {
				traps++;
				return 1;
			},
		},
	);
	const wf = defineWorkflow({ name: "input-proxy", run: () => null });
	const engine = createWorkflowEngine();
	await expect(engine.start(wf, proxy, { runId: "proxy" })).rejects.toThrow(
		"workflow input must be JSON-normalized",
	);
	expect(traps).toBe(0);
	expect(await engine.journal("proxy")).toEqual([]);
});

it("accepts ordinary generated JSON trees including special property names", async () => {
	const wf = defineWorkflow({
		name: "json-input",
		run: (_ctx, value) => value,
	});
	await fc.assert(
		fc.asyncProperty(fc.jsonValue({ maxDepth: 3 }), async (generated) => {
			const input = JSON.parse(JSON.stringify(generated));
			const result = await createWorkflowEngine().start(wf, input);
			expect(result.result).toEqual(input);
		}),
		{ seed: 614607, numRuns: 100 },
	);
	const special = JSON.parse('{"__proto__":{"nested":1},"constructor":[]}');
	expect((await createWorkflowEngine().start(wf, special)).result).toEqual(
		special,
	);
});
