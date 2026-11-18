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
		await expect(engine.resume(wf, "missing", value)).rejects.toThrow(
			"workflow input must be JSON-normalized",
		);
	}
	expect(calls).toBe(0);
});
