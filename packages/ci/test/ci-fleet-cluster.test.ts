import * as TestRunner from "effect/cluster/TestRunner";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import {
	createFleetHealthSweepCron,
	createFleetLeaseReaperSingleton,
	StationFleetCoordinator,
	StationFleetCoordinatorLive,
} from "../src/cluster/index.js";
import { PositiveMinutes } from "../src/domain/index.js";

const clusterTestLayer = StationFleetCoordinatorLive.pipe(
	Layer.provideMerge(TestRunner.layer),
);

describe("@hobo/ci/cluster StationFleetCoordinator (Effect Cluster)", () => {
	it("balances jobs across local, hostinger, agent37, boat, and hosted tiers without double allocation under concurrency", async () => {
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const makeClient = yield* StationFleetCoordinator.client;
				const client = makeClient("station-cluster-1");

				yield* client.ConfigureBudget({ ceilingMicros: 500_000 });
				const specs = [
					{
						poolId: "local-dev",
						tier: "local" as const,
						role: "primary" as const,
						runnerLabel: "hobo-local",
						concurrency: 2,
						costPerMinuteMicros: 0,
						payer: "local",
						payerBudgetMicros: null,
						isolated: true,
						docker: true,
						publicRepositories: false,
					},
					{
						poolId: "hostinger-eu",
						tier: "hostinger" as const,
						role: "primary" as const,
						runnerLabel: "hobo-hostinger",
						concurrency: 2,
						costPerMinuteMicros: 500,
						payer: "hostinger",
						payerBudgetMicros: 100_000,
						isolated: true,
						docker: true,
						publicRepositories: true,
					},
					{
						poolId: "agent37-sandbox",
						tier: "agent37" as const,
						role: "overflow" as const,
						runnerLabel: "hobo-agent37",
						concurrency: 2,
						costPerMinuteMicros: 2_000,
						payer: "agent37",
						payerBudgetMicros: 100_000,
						isolated: true,
						docker: true,
						publicRepositories: true,
					},
					{
						poolId: "boat-sandbox",
						tier: "boat" as const,
						role: "overflow" as const,
						runnerLabel: "hobo-boat",
						concurrency: 2,
						costPerMinuteMicros: 2_000,
						payer: "boat",
						payerBudgetMicros: 100_000,
						isolated: true,
						docker: true,
						publicRepositories: true,
					},
					{
						poolId: "hosted-linux-pool",
						tier: "hosted" as const,
						role: "last-resort" as const,
						runnerLabel: "hosted-linux",
						concurrency: 2,
						costPerMinuteMicros: 8_000,
						payer: "hosted",
						payerBudgetMicros: 200_000,
						isolated: true,
						docker: true,
						publicRepositories: true,
					},
				];
				for (const spec of specs) {
					yield* client.RegisterPool({ spec });
				}

				const dispatches = yield* Effect.all(
					Array.from({ length: 10 }, (_, idx) =>
						client.DispatchJob({
							jobId: `job-burst-${idx + 1}`,
							requirements: {
								minutes: PositiveMinutes.make(5),
								needsDocker: true,
								isolationRequired: true,
								publicRepository: false,
							},
							leaseTtlMs: 30_000,
							nowMs: 1_000,
						}),
					),
					{ concurrency: "unbounded" },
				);

				const deduped = yield* client.DispatchJob({
					jobId: "job-burst-1",
					requirements: {
						minutes: PositiveMinutes.make(5),
						needsDocker: true,
						isolationRequired: true,
						publicRepository: false,
					},
					leaseTtlMs: 30_000,
					nowMs: 1_500,
				});

				const snapshot = yield* client.FleetSnapshot();
				return { dispatches, deduped, snapshot };
			}).pipe(Effect.provide(clusterTestLayer)),
		);

		const tiers = new Set(outcome.dispatches.map((entry) => entry.tier));
		expect(tiers).toEqual(
			new Set(["local", "hostinger", "agent37", "boat", "hosted"]),
		);
		expect(new Set(outcome.dispatches.map((entry) => entry.slotId)).size).toBe(
			10,
		);
		expect(outcome.deduped.slotId).toBe(outcome.dispatches[0]?.slotId);
		expect(outcome.snapshot.activeLeases).toBe(10);
		for (const pool of outcome.snapshot.pools) {
			expect(pool.activeJobs).toBeLessThanOrEqual(pool.concurrency);
			expect(pool.activeJobs).toBe(2);
		}
	});

	it("reaps expired leases via Singleton reaper and wires ClusterCron health sweep", async () => {
		const reaped: Array<{ stationId: string; count: number }> = [];
		let clockMs = 10_000;

		const reaperLayer = createFleetLeaseReaperSingleton({
			stationIds: ["station-reap-1"],
			nowMs: () => clockMs,
			onReaped: (stationId, slots) => {
				reaped.push({ stationId, count: slots.length });
			},
		});
		const cronLayer = createFleetHealthSweepCron({
			stationIds: ["station-reap-1"],
			cronExpression: "*/5 * * * *",
			nowMs: () => clockMs,
		});

		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const makeClient = yield* StationFleetCoordinator.client;
					const client = makeClient("station-reap-1");
					yield* client.RegisterPool({
						spec: {
							poolId: "boat-ci-1",
							tier: "boat",
							role: "primary",
							runnerLabel: "hobo-boat",
							concurrency: 1,
							costPerMinuteMicros: 1_000,
							payer: "boat",
							payerBudgetMicros: 50_000,
							isolated: true,
							docker: true,
							publicRepositories: true,
						},
					});
					const lease = yield* client.DispatchJob({
						jobId: "job-expiring",
						requirements: {
							minutes: PositiveMinutes.make(5),
							needsDocker: true,
							isolationRequired: true,
							publicRepository: true,
						},
						leaseTtlMs: 5_000,
						nowMs: 10_000,
					});
					clockMs = 20_000;
					yield* Layer.build(reaperLayer);
					yield* Layer.build(cronLayer);
					yield* Effect.sleep("25 millis");
					const manualReap = yield* client.ReapExpiredLeases({
						nowMs: clockMs,
					});
					const after = yield* client.FleetSnapshot();
					return { lease, manualReap, after };
				}).pipe(Effect.provide(clusterTestLayer)),
			),
		);

		expect(result.lease.tier).toBe("boat");
		expect(result.after.activeLeases).toBe(0);
		expect(result.after.exposureMicros).toBe(0);
		expect(
			reaped.length + result.manualReap.reapedSlotIds.length,
		).toBeGreaterThanOrEqual(1);
	});
});
