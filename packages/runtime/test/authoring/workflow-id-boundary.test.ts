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

it("does not let a numeric resume ID alias an active string run", async () => {
	const store = createInMemoryEventStore();
	const entered = deferred();
	const duplicate = deferred();
	const release = deferred();
	let calls = 0;
	const wf = defineWorkflow({
		name: "identity-alias",
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
	const running = engine.start(wf, null, { runId: "1" }).then(
		(value) => ({ value }),
		(error) => ({ error }),
	);
	await entered.promise;
	const numericId = JSON.parse("1");
	const competing = engine.resume(wf, numericId, null).then(
		(value) => ({ value }),
		(error) => ({ error }),
	);
	await Promise.race([competing, duplicate.promise]);
	release.resolve();
	const [first, second] = await Promise.all([running, competing]);
	expect(second.error).toBeInstanceOf(TypeError);
	expect(String(second.error)).toMatch(/runId must be a non-empty string/);
	expect(first.value?.status).toBe("completed");
	expect(calls).toBe(1);
});

it("rejects non-string and empty IDs at start, resume and journal boundaries", async () => {
	const engine = createWorkflowEngine();
	const wf = defineWorkflow({ name: "invalid-run-id", run: () => "ok" });
	await fc.assert(
		fc.asyncProperty(
			fc.oneof(
				fc.integer(),
				fc.boolean(),
				fc.constant(null),
				fc.constant(""),
				fc.array(fc.string(), { maxLength: 2 }),
				fc.constant({}),
			),
			async (id) => {
				const dynamicId = JSON.parse(JSON.stringify(id));
				await expect(
					engine.start(wf, null, { runId: dynamicId }),
				).rejects.toThrow("workflow runId must be a non-empty string");
				await expect(engine.resume(wf, dynamicId, null)).rejects.toThrow(
					"workflow runId must be a non-empty string",
				);
				await expect(engine.journal(dynamicId)).rejects.toThrow(
					"workflow runId must be a non-empty string",
				);
			},
		),
		{ seed: 614605, numRuns: 100 },
	);
	for (const id of [JSON.parse("{}").missing, Object("1")]) {
		await expect(engine.resume(wf, id, null)).rejects.toThrow(
			"workflow runId must be a non-empty string",
		);
		await expect(engine.journal(id)).rejects.toThrow(
			"workflow runId must be a non-empty string",
		);
	}
});
