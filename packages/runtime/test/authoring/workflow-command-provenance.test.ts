import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventInput } from "@hobo/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createRuntimeLocalEventStore } from "../../../runtimes/runtime-local/dist/eventstore/eventstore.js";
import { isJsonObject } from "../../src/json.js";
import {
	createEventStoreReader,
	type EventStoreWriter,
} from "../../src/replay/store.js";
import { createWorkflowEngine, defineWorkflow } from "../../src/workflow.js";

describe("workflow command provenance", () => {
	it("persists parent provenance when a SQLite journal is reopened", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-command-parent-"));
		let durable = createRuntimeLocalEventStore({ dataDir: directory });
		try {
			const writer: EventStoreWriter = {
				...createEventStoreReader(durable),
				async append(event, expectedSeq) {
					if (expectedSeq === undefined)
						throw new Error("expected sequence required");
					const input: EventInput = {
						type: event.type,
						v: event.v,
						data: event.data,
					};
					if (event.meta !== undefined) input.meta = event.meta;
					await durable.append(event.streamId, [input], {
						expectedSeq,
						actor: { kind: "system", id: "parent-test" },
						tenant: "parent-test",
					});
				},
			};
			const wf = defineWorkflow({
				name: "parent-persistence",
				async run(ctx) {
					return ctx.step("parent", () => ctx.step("child", () => 1));
				},
			});
			await createWorkflowEngine({ store: writer }).start(wf, null, {
				runId: "parent",
			});
			durable.close();
			durable = createRuntimeLocalEventStore({ dataDir: directory });
			const events =
				await createEventStoreReader(durable).readStream("run/parent");
			const scheduled = events.filter(
				(event) => event.type === "run.StepScheduled",
			);
			expect(scheduled.map((event) => event.data)).toEqual([
				{ name: "parent", index: 0, parentStepIndex: null },
				{ name: "child", index: 1, parentStepIndex: 0 },
			]);
		} finally {
			durable.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("records each nested step and sleep under its actual concurrent parent", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 0, max: 4 }),
				fc.integer({ min: 0, max: 4 }),
				async (leftDelay, rightDelay) => {
					const engine = createWorkflowEngine();
					const wf = defineWorkflow({
						name: "nested-parents",
						async run(ctx) {
							const work = (name: string, delay: number) =>
								ctx.step(name, async () => {
									for (let i = 0; i < delay; i++) await Promise.resolve();
									await ctx.sleep(0, { label: name });
									return ctx.step(`${name}-child`, () =>
										ctx.step(`${name}-grandchild`, () => name),
									);
								});
							const values = await Promise.all([
								work("left", leftDelay),
								work("right", rightDelay),
							]);
							await ctx.step("root-after", () => null);
							return values;
						},
					});
					const result = await engine.start(wf, null);
					expect(result.result).toEqual(["left", "right"]);
					const journal = await engine.journal(result.runId);
					const started = journal.find((event) => event.type === "run.Started");
					expect(started?.data).toMatchObject({ commandTreeVersion: 2 });
					const steps = journal.filter(
						(event) => event.type === "run.StepScheduled",
					);
					const left = steps.find(
						(event) => isJsonObject(event.data) && event.data.name === "left",
					);
					const right = steps.find(
						(event) => isJsonObject(event.data) && event.data.name === "right",
					);
					if (
						!left ||
						!right ||
						!isJsonObject(left.data) ||
						!isJsonObject(right.data)
					)
						throw new Error("missing parent step");
					expect(left.data.parentStepIndex).toBeNull();
					expect(right.data.parentStepIndex).toBeNull();
					const child = (name: string) =>
						steps.find(
							(event) =>
								isJsonObject(event.data) && event.data.name === `${name}-child`,
						);
					expect(child("left")?.data).toMatchObject({
						parentStepIndex: left.data.index,
					});
					expect(child("right")?.data).toMatchObject({
						parentStepIndex: right.data.index,
					});
					const leftChild = child("left");
					const rightChild = child("right");
					if (
						!leftChild ||
						!rightChild ||
						!isJsonObject(leftChild.data) ||
						!isJsonObject(rightChild.data)
					)
						throw new Error("missing child step");
					const grandchild = (name: string) =>
						steps.find(
							(event) =>
								isJsonObject(event.data) &&
								event.data.name === `${name}-grandchild`,
						);
					expect(grandchild("left")?.data).toMatchObject({
						parentStepIndex: leftChild.data.index,
					});
					expect(grandchild("right")?.data).toMatchObject({
						parentStepIndex: rightChild.data.index,
					});
					expect(
						steps.find(
							(event) =>
								isJsonObject(event.data) && event.data.name === "root-after",
						)?.data,
					).toMatchObject({ parentStepIndex: null });
					const sleeps = journal.filter(
						(event) => event.type === "run.SleepScheduled",
					);
					const sleep = (name: string) =>
						sleeps.find(
							(event) => isJsonObject(event.data) && event.data.label === name,
						);
					expect(sleep("left")?.data).toMatchObject({
						parentStepIndex: left.data.index,
					});
					expect(sleep("right")?.data).toMatchObject({
						parentStepIndex: right.data.index,
					});
				},
			),
			{ seed: 614461, numRuns: 100 },
		);
	});
});
