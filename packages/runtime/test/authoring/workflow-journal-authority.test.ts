import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isJsonObject } from "../../src/json.js";
import { createWorkflowEngine, defineWorkflow } from "../../src/workflow.js";

describe("workflow journal authority", () => {
	it("does not allow application events to impersonate runtime records", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.oneof(
					fc.constantFrom(
						"Started",
						"Completed",
						"Failed",
						"StepCompleted",
						"SleepCompleted",
					),
					fc.string({ maxLength: 20 }),
				),
				async (suffix) => {
					const engine = createWorkflowEngine();
					const wf = defineWorkflow({
						name: "reserved-event",
						async run(ctx) {
							await expect(
								ctx.emit(`run.${suffix}`, { result: "forged" }),
							).rejects.toThrow(/reserved/i);
							await ctx.emit("runway.Completed", { ok: true });
							return "actual";
						},
					});
					const live = await engine.start(wf, null);
					expect(live.result).toBe("actual");
					const events = await engine.journal(live.runId);
					expect(
						events.filter((event) => event.type === "run.Completed"),
					).toHaveLength(1);
					expect(
						events.some((event) => event.type === "runway.Completed"),
					).toBe(true);
					expect((await engine.resume(wf, live.runId, null)).result).toBe(
						"actual",
					);
				},
			),
			{ seed: 614464, numRuns: 100 },
		);
	});

	it("refuses a terminal result when its recorded sleep completion is missing", async () => {
		let calls = 0;
		const wf = defineWorkflow({
			name: "missing-terminal-evidence",
			async run(ctx) {
				calls++;
				await ctx.sleep(0);
				return "done";
			},
		});
		const engine = createWorkflowEngine();
		const live = await engine.start(wf, null);
		const events = await engine.store.readStream(`run/${live.runId}`);
		const damaged = events.filter(
			(event) => event.type !== "run.SleepCompleted",
		);
		const reader = { ...engine.store, readStream: async () => damaged };
		await expect(
			createWorkflowEngine({ store: reader }).resume(wf, live.runId, null),
		).rejects.toThrow(/sleep.*completion/i);
		expect(calls).toBe(1);
		expect(await engine.store.readStream(`run/${live.runId}`)).toEqual(events);
	});

	it("refuses terminal histories with duplicate outcomes or records after the outcome", async () => {
		const wf = defineWorkflow({
			name: "duplicate-terminal",
			run: () => "done",
		});
		const engine = createWorkflowEngine();
		const live = await engine.start(wf, null);
		const events = await engine.store.readStream(`run/${live.runId}`);
		const terminal = events.find((event) => event.type === "run.Completed");
		if (!terminal) throw new Error("missing terminal outcome");
		for (const extra of [
			{ ...terminal, id: "duplicate", seq: terminal.seq + 1 },
			{ ...terminal, id: "late", seq: terminal.seq + 1, type: "app.Late" },
		]) {
			const reader = {
				...engine.store,
				readStream: async () => [...events, extra],
			};
			await expect(
				createWorkflowEngine({ store: reader }).resume(wf, live.runId, null),
			).rejects.toThrow(/terminal/i);
		}
	});

	it("refuses an unknown command-tree version before returning a terminal result", async () => {
		const wf = defineWorkflow({ name: "unknown-version", run: () => "done" });
		const engine = createWorkflowEngine();
		const live = await engine.start(wf, null);
		const events = await engine.store.readStream(`run/${live.runId}`);
		const unknown = events.map((event) =>
			event.type === "run.Started" && isJsonObject(event.data)
				? { ...event, data: { ...event.data, commandTreeVersion: 999 } }
				: event,
		);
		const reader = { ...engine.store, readStream: async () => unknown };
		await expect(
			createWorkflowEngine({ store: reader }).resume(wf, live.runId, null),
		).rejects.toThrow(/unsupported.*version/i);
	});
});
