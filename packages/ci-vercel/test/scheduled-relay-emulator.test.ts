import { ACTIVE_STATES } from "@hobo/ci";
import { parseScheduleId } from "@hobo/core";
import { createScheduleEmulator } from "@hobo/testing";
import { describe, expect, it } from "vitest";
import { RELAY_REPAIR_SCHEDULE } from "../src/bindle.js";
import { RELAY_QUEUE_TOPICS } from "../src/relay-queue.js";
import {
	ORIGIN,
	openStatelessRelay,
	type StatelessHarness,
} from "./stateless-harness.js";

const MINUTE = 60_000;
const REPAIR_INTERVAL = 15 * MINUTE;
const JOB = 4001;

function scheduledRepair(h: StatelessHarness) {
	const emulator = createScheduleEmulator();
	const driver = emulator.driver;
	if (!driver) throw new Error("The local schedule driver is unavailable.");
	driver.registerJob(
		parseScheduleId(RELAY_REPAIR_SCHEDULE.name),
		{ everyMs: REPAIR_INTERVAL },
		async () => {
			const response = await h.relay.handle(
				new Request(`${ORIGIN}/internal/tick`, {
					headers: { authorization: `Bearer ${h.entries.CRON_SECRET}` },
				}),
			);
			if (response.status !== 204)
				throw new Error(`The synthetic tick returned ${response.status}.`);
		},
	);
	return {
		async advance(ms: number) {
			h.clock.advance(ms);
			return driver.advance(ms);
		},
		async close() {
			await emulator.close?.();
		},
	};
}

describe("the stateless relay with a local schedule driver", () => {
	it("routes timed repair through the queue and suppresses duplicate redelivery", async () => {
		const h = await openStatelessRelay();
		const schedule = scheduledRepair(h);
		try {
			expect(RELAY_REPAIR_SCHEDULE.cron).toBe("*/15 * * * *");
			h.deliveries.push({
				id: 71,
				guid: "missed",
				event: "workflow_job",
				status_code: 502,
				delivered_at: new Date(h.clock.nowMs() - 5 * MINUTE).toISOString(),
			});
			expect(await schedule.advance(REPAIR_INTERVAL - 1)).toEqual([]);
			expect(
				h.queued.filter((item) => item.topic === RELAY_QUEUE_TOPICS.repair),
			).toEqual([]);
			expect(
				(await schedule.advance(1)).map((fire) => fire.occurrence),
			).toEqual([1]);
			const repair = h.queued.find(
				(item) => item.topic === RELAY_QUEUE_TOPICS.repair,
			);
			if (!repair) throw new Error("The repair tick did not reach the queue.");
			expect(h.redeliveries).toEqual([]);
			await h.drain(RELAY_QUEUE_TOPICS.repair);
			expect(h.redeliveries).toEqual([71]);
			expect(await h.relay.store.accountsAwaitingRebuild()).toEqual([]);
			await h.redeliver(repair.payload);
			expect(h.redeliveries).toEqual([71]);
			expect(
				(await schedule.advance(REPAIR_INTERVAL + MINUTE)).map(
					(fire) => fire.occurrence,
				),
			).toEqual([2]);
			await h.drain(RELAY_QUEUE_TOPICS.repair);
			expect(h.redeliveries).toEqual([71, 71]);
			expect(h.failures).toEqual([]);
		} finally {
			await schedule.close();
			await h.relay.close();
		}
	});

	it("rebuilds one lease and settles once after duplicate delivery and cache loss", async () => {
		const h = await openStatelessRelay();
		const schedule = scheduledRepair(h);
		try {
			await schedule.advance(REPAIR_INTERVAL);
			await h.drain(RELAY_QUEUE_TOPICS.repair);
			h.jobs.set(JOB, {
				id: JOB,
				status: "queued",
				runnerName: null,
				runnerId: null,
			});
			expect(
				(await h.webhook("queued", JOB, "delivery-a")).response.status,
			).toBe(202);
			expect(
				(await h.webhook("queued", JOB, "delivery-a")).response.status,
			).toBe(202);
			const intake = h.queued.find(
				(item) => item.topic === RELAY_QUEUE_TOPICS.intake,
			);
			if (!intake)
				throw new Error("The webhook did not reach the intake queue.");
			await h.drain(RELAY_QUEUE_TOPICS.intake);
			await h.redeliver(intake.payload);
			await h.webhook("queued", JOB, "delivery-b");
			await h.drain(RELAY_QUEUE_TOPICS.intake);
			const leases = await h.relay.store.accountLeases("hobo-labs");
			expect(leases).toHaveLength(1);
			const [lease] = leases;
			if (!lease) throw new Error("The queued job did not create a lease.");
			const step = h.queued.find(
				(item) => item.topic === RELAY_QUEUE_TOPICS.steps,
			);
			if (!step) throw new Error("The lease did not schedule a worker step.");
			expect(lease.state).toBe("running");
			expect(h.sandbox.creates).toBe(1);
			expect(h.github.jitRegistrations).toBe(1);
			const github = h.github.job(JOB);
			github.status = "in_progress";
			github.runnerName = lease.runnerName;
			github.runnerId = 31;
			h.wipeCache();
			await schedule.advance(MINUTE);
			await h.drain(RELAY_QUEUE_TOPICS.steps);
			expect((await h.relay.store.get(lease.id))?.state).toBe("uncertain");
			await schedule.advance(REPAIR_INTERVAL - MINUTE);
			const repair = h.queued.find(
				(item) => item.topic === RELAY_QUEUE_TOPICS.repair,
			);
			if (!repair) throw new Error("The scheduled repair was not queued.");
			await h.drain(RELAY_QUEUE_TOPICS.repair);
			expect(await h.relay.store.accountsAwaitingRebuild()).toEqual([]);
			expect(
				(await h.relay.store.accountLeases("hobo-labs")).map((item) => item.id),
			).toEqual([lease.id]);
			expect(h.sandbox.creates).toBe(1);
			h.sandbox.proxyMeters.set(`hobo-proxy-${lease.id}`, {
				bytes: 262_144,
				calls: 4,
			});
			github.status = "completed";
			const guest = h.vms.get(`hobo-${lease.id}`);
			if (!guest) throw new Error("The guest sandbox is unavailable.");
			guest.exitCode = 0;
			await schedule.advance(REPAIR_INTERVAL);
			await h.drain();
			const settled = await h.relay.store.get(lease.id);
			if (!settled) throw new Error("The settled lease is unavailable.");
			expect(settled.state).toBe("completed");
			expect(Number.isFinite(Date.parse(settled.settledAt))).toBe(true);
			expect(Number.isFinite(Date.parse(settled.usageCompletedAt))).toBe(true);
			expect(settled.sandboxUsedAllowance).toBeDefined();
			expect(settled.runnerDeletionConfirmed).toBe(true);
			const settlement = {
				settledAt: settled.settledAt,
				usageCompletedAt: settled.usageCompletedAt,
				usageProvenance: settled.usageProvenance,
				paidMicros: settled.paidMicros,
				billedMinutes: settled.billedMinutes,
				billedFreeMinutes: settled.billedFreeMinutes,
				sandboxUsedAllowance: settled.sandboxUsedAllowance,
			};
			expect(guest.stopped).toBe(true);
			expect(h.vms.get(`hobo-proxy-${lease.id}`)?.stopped).toBe(true);
			expect(h.sandbox.meterReads).toBe(1);
			expect(h.sandbox.stops).toBe(1);
			const runnerDeletes = () =>
				h.github.requests.filter(
					(request) => request === "DELETE /repos/Org/Repo/actions/runners/31",
				).length;
			expect(runnerDeletes()).toBe(1);
			await h.redeliver(repair.payload);
			await h.redeliver(step.payload);
			expect(await h.relay.store.get(lease.id)).toMatchObject({
				state: "completed",
				...settlement,
			});
			expect(
				(await h.relay.store.events()).filter(
					(event) => event.type === "ci.HostSettled",
				),
			).toHaveLength(1);
			expect(h.sandbox.creates).toBe(1);
			expect(h.sandbox.stops).toBe(1);
			expect(h.sandbox.meterReads).toBe(1);
			expect(h.github.jitRegistrations).toBe(1);
			expect(runnerDeletes()).toBe(1);
			expect(h.failures).toEqual([]);
			expect(
				(await h.relay.store.activeLeases()).filter((item) =>
					ACTIVE_STATES.has(item.state),
				),
			).toEqual([]);
		} finally {
			await schedule.close();
			await h.relay.close();
		}
	});
});
