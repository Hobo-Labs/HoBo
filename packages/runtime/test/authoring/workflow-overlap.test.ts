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

it("rejects concurrent resumes using the same store even across engine instances", async () => {
	const store = createInMemoryEventStore();
	const entered = deferred();
	const duplicate = deferred();
	const release = deferred();
	let crash = true;
	let calls = 0;
	const wf = defineWorkflow({
		name: "resume-overlap",
		async run(ctx) {
			if (crash) {
				crash = false;
				throw new Error("host stopped");
			}
			return ctx.step("effect", async () => {
				calls++;
				if (calls === 1) entered.resolve();
				else duplicate.resolve();
				await release.promise;
				return "done";
			});
		},
	});
	const first = createWorkflowEngine({ store });
	const second = createWorkflowEngine({ store });
	await expect(
		first.start(wf, null, { runId: "resume-overlap" }),
	).rejects.toThrow("host stopped");
	const running = first.resume(wf, "resume-overlap", null);
	await entered.promise;
	const competing = second.resume(wf, "resume-overlap", null);
	const result = competing.then(
		() => "completed",
		(error) => error,
	);
	await Promise.race([result, duplicate.promise]);
	release.resolve();
	const [completed, rejected] = await Promise.all([running, result]);
	expect(completed.status).toBe("completed");
	expect(rejected).toBeInstanceOf(Error);
	expect(String(rejected)).toMatch(/already executing/i);
	expect(calls).toBe(1);
	expect((await second.resume(wf, "resume-overlap", null)).result).toBe("done");
	expect(calls).toBe(1);
});

it("keeps a run fenced after its parent exits while a durable command remains active", async () => {
	const store = createInMemoryEventStore();
	const entered = deferred();
	const duplicate = deferred();
	const release = deferred();
	let detached = true;
	let calls = 0;
	let orphan: Promise<unknown> = Promise.resolve();
	const wf = defineWorkflow({
		name: "pending-overlap",
		async run(ctx) {
			const step = ctx.step("effect", async () => {
				calls++;
				if (calls === 1) {
					entered.resolve();
					await release.promise;
				} else duplicate.resolve();
				return "done";
			});
			if (!detached) return step;
			orphan = step.catch((error) => error);
			await entered.promise;
			return "parent exited";
		},
	});
	const first = createWorkflowEngine({ store });
	const second = createWorkflowEngine({ store });
	await expect(
		first.start(wf, null, { runId: "pending-overlap" }),
	).rejects.toThrow(/outstanding/i);
	detached = false;
	const competing = second.resume(wf, "pending-overlap", null);
	const result = competing.then(
		() => "completed",
		(error) => error,
	);
	await Promise.race([result, duplicate.promise]);
	const earlyCalls = calls;
	release.resolve();
	await orphan;
	const rejected = await result;
	expect(rejected).toBeInstanceOf(Error);
	expect(String(rejected)).toMatch(/already executing/i);
	expect(earlyCalls).toBe(1);
	const recovered = await second.resume(wf, "pending-overlap", null);
	expect(recovered.status).toBe("completed");
	expect(calls).toBe(2);
});

it("releases the local fence when setup fails before any command starts", async () => {
	const base = createInMemoryEventStore();
	let fail = true;
	const store = {
		...base,
		async append(event: Parameters<typeof base.append>[0], expected?: number) {
			if (fail) {
				fail = false;
				throw new Error("journal unavailable");
			}
			return base.append(event, expected);
		},
	};
	const engine = createWorkflowEngine({ store });
	const wf = defineWorkflow({ name: "setup-failure", run: () => "ok" });
	await expect(
		engine.start(wf, null, { runId: "setup-failure" }),
	).rejects.toThrow("journal unavailable");
	await expect(
		engine.start(wf, null, { runId: "setup-failure" }),
	).resolves.toMatchObject({ result: "ok" });
});

it("rejects generated overlapping resume attempts without blocking other runs", async () => {
	await fc.assert(
		fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async (count) => {
			const store = createInMemoryEventStore();
			const entered = deferred();
			const duplicate = deferred();
			const release = deferred();
			let calls = 0;
			const wf = defineWorkflow({
				name: "generated-overlap",
				async run(ctx) {
					return ctx.step("effect", async () => {
						calls++;
						if (calls === 1) entered.resolve();
						else duplicate.resolve();
						await release.promise;
						return "done";
					});
				},
			});
			const engine = createWorkflowEngine({ store });
			const running = engine.start(wf, null, { runId: "generated-overlap" });
			await entered.promise;
			const independentWorkflow = defineWorkflow({
				name: "independent",
				run: () => "ok",
			});
			const independent = await engine.start(independentWorkflow, null, {
				runId: "independent",
			});
			expect(independent.result).toBe("ok");
			const otherStore = createWorkflowEngine({
				store: createInMemoryEventStore(),
			});
			const sameIdElsewhere = await otherStore.start(
				independentWorkflow,
				null,
				{ runId: "generated-overlap" },
			);
			expect(sameIdElsewhere.result).toBe("ok");
			const others = Array.from({ length: count }, () =>
				createWorkflowEngine({ store }).resume(wf, "generated-overlap", null),
			);
			const settled = Promise.allSettled(others);
			await Promise.race([settled, duplicate.promise]);
			release.resolve();
			await running;
			const results = await settled;
			expect(results.every((result) => result.status === "rejected")).toBe(
				true,
			);
			expect(calls).toBe(1);
		}),
		{ seed: 614604, numRuns: 30 },
	);
});
