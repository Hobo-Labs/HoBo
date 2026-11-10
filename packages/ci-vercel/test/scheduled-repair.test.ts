import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { normalizeQueueWakeup } from "../src/queue-forwarding.js";
import { createScheduledRepairHandler } from "../src/scheduled-repair.js";
import {
	createHostedWorker,
	isPlatformScheduleRun,
	QueueMessageSchema,
} from "../src/worker.js";

const secret = "secret-for-our-cron-needs-32-bytes";
const request = (authorization?: string, method = "GET") =>
	new Request("https://relay.example/internal/tick", {
		method,
		headers: authorization ? { authorization } : {},
	});

describe("scheduled repair", () => {
	it("schedules repair on the private queue and never on a public route", async () => {
		const config = JSON.parse(
			await readFile(new URL("../vercel.json", import.meta.url), "utf8"),
		);
		// A cron or a path schedule would call a public URL; the queue consumer
		// is private, so a topic target needs no shared secret.
		expect(config.crons).toBeUndefined();
		expect(config.schedules).toEqual({
			"hobo-ci-repair": { schedule: "*/15 * * * *", topic: "hobo-ci" },
		});
		const consumer = config.functions["api/queue.ts"].experimentalTriggers;
		expect(consumer).toEqual([{ type: "queue/v2beta", topic: "hobo-ci" }]);
	});
	it("accepts the scheduler's run message and tells it from the relay's own", () => {
		// The shape Vercel publishes for a static schedule with a topic target.
		const run = QueueMessageSchema.parse({
			scheduleId: "sch_example",
			executionId: "schx_example",
			name: "hobo-ci-repair",
			namespace: "default",
			scheduledAt: "2026-11-10T05:00:00.000Z",
			expression: "*/15 * * * *",
			source: "static",
		});
		expect(isPlatformScheduleRun(run)).toBe(true);
		expect(normalizeQueueWakeup(run)).toEqual({
			source: "static",
			name: "hobo-ci-repair",
		});
		for (const own of [
			{ source: "static", name: "hobo-ci-repair" },
			{ source: "hobo-ci", name: "hobo-ci-repair" },
			{ deliveryId: "delivery-1" },
			null,
		])
			expect(isPlatformScheduleRun(QueueMessageSchema.parse(own))).toBe(false);
		// A schedule under any other name is not repair.
		expect(() =>
			QueueMessageSchema.parse({
				scheduleId: "sch_other",
				name: "other",
				source: "static",
			}),
		).toThrow();
	});
	it("requires a sufficiently strong secret and rejects unauthorized requests", async () => {
		const enqueue = vi.fn(async () => {});
		expect(() =>
			createScheduledRepairHandler({ secret: "short", enqueue }),
		).toThrow();
		const handler = createScheduledRepairHandler({ secret, enqueue });
		for (const bad of [
			request(),
			request("Bearer wrong"),
			request(`Bearer ${secret}`, "POST"),
		])
			expect((await handler(bad)).status).toBe(403);
		expect(enqueue).not.toHaveBeenCalled();
	});
	it("enqueues authenticated repair and reports queue failure for later retry", async () => {
		const enqueue = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("unavailable"));
		const handler = createScheduledRepairHandler({ secret, enqueue });
		expect((await handler(request(`Bearer ${secret}`))).status).toBe(204);
		expect((await handler(request(`Bearer ${secret}`))).status).toBe(503);
		expect(enqueue).toHaveBeenCalledTimes(2);
	});
	it("records schedule and repair health only after the private consumer succeeds", async () => {
		const marks: [string, boolean][] = [];
		const worker = createHostedWorker({
			tick: async () => {},
			repair: async () => ({ truncated: false, more: false }),
			continueRepair: async () => {},
			health: {
				mark: async (component, ok) => {
					marks.push([component, ok]);
				},
				ready: async () => true,
			},
		});
		let queued = false;
		const handler = createScheduledRepairHandler({
			secret,
			enqueue: async () => {
				queued = true;
			},
		});
		expect((await handler(request(`Bearer ${secret}`))).status).toBe(204);
		expect(queued).toBe(true);
		expect(marks).toEqual([]);
		await worker.run({ source: "static", name: "hobo-ci-repair" });
		expect(marks).toEqual([
			["queue", true],
			["repair", true],
			["schedule", true],
		]);
	});
});
