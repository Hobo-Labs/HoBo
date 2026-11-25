import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Domain from "@alchemy.run/domain";
import type { PoolHost } from "@alchemy.run/rivet/Host";
import { NodeHttpServer } from "@effect/platform-node";
import { createNodeSqliteDriver } from "@hobo/storage-sqlite";
import * as Effect from "effect/Effect";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import { setupTest } from "rivetkit/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CiFleetApi,
	ExternalRunnerId,
	JobDispatchId,
	NonNegativeCount,
	NonNegativeMicros,
	PayerId,
	PositiveConcurrency,
	PositiveMinutes,
	RunnerBackend,
	RunnerLabel,
	RunnerPoolId,
	SlotId,
	StationId,
} from "../src/domain/index.js";
import {
	type CiStationLeaseEvent,
	createCiFleetInMemoryLayer,
	createCiFleetRivetLayer,
	createCiFleetSqliteLayer,
	createCiStationLeaseRegistry,
} from "../src/host/index.js";
import { startLocalRivetTestEngine } from "./support/rivet-test-engine.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const LOCAL_POOL = {
	poolId: RunnerPoolId.make("local-devbox"),
	tier: "local" as const,
	role: "primary" as const,
	runnerLabel: RunnerLabel.make("hobo-local-host"),
	concurrency: PositiveConcurrency.make(2),
	costPerMinuteMicros: NonNegativeMicros.make(0),
	payer: PayerId.make("local"),
	payerBudgetMicros: null,
	isolated: false,
	docker: true,
	publicRepositories: false,
};

const RunnerBackendStub = RunnerBackend.toLayer(
	Effect.succeed({
		provisionRunner: ({ slotId }) =>
			Effect.succeed({
				externalRunnerId: ExternalRunnerId.make(`runner-${slotId}`),
			}),
		releaseRunner: () => Effect.succeed({ released: true }),
	}),
);

describe("@hobo/ci/host portable hosting (InMemory, HTTP, SQLite, Rivet)", () => {
	it("serves CiFleetApi in-process and over real HTTP transport via NodeHttpServer.layerTest + Domain.protocolHttp", async () => {
		const stationId = StationId.make("station-http-1");
		const jobId = JobDispatchId.make("job-http-1");

		const InMemoryWorld = createCiFleetInMemoryLayer(RunnerBackendStub);
		const inProcessCapacity = await Effect.runPromise(
			Effect.gen(function* () {
				const client = yield* CiFleetApi.clientInProcess;
				yield* client.ConfigureStationBudget(stationId, {
					ceilingMicros: NonNegativeMicros.make(100_000),
				});
				const receipt = yield* client.RegisterRunnerPool(stationId, {
					spec: LOCAL_POOL,
				});
				return yield* client.FleetCapacityView.get(stationId, {
					atLeast: receipt,
				});
			}).pipe(Effect.scoped, Effect.provide(InMemoryWorld)),
		);
		expect(inProcessCapacity?.pools).toHaveLength(1);

		const ApiServer = Layer.unwrap(
			Effect.gen(function* () {
				const api = yield* CiFleetApi;
				return HttpServer.serve()(api.fetch);
			}),
		).pipe(
			Layer.provide(createCiFleetInMemoryLayer(RunnerBackendStub)),
			Layer.provideMerge(NodeHttpServer.layerTest),
		);

		const HttpWorld = Layer.provideMerge(Domain.protocolHttp(""), ApiServer);

		const httpResult = await Effect.runPromise(
			Effect.gen(function* () {
				const client = yield* CiFleetApi.client;
				yield* client.ConfigureStationBudget(stationId, {
					ceilingMicros: NonNegativeMicros.make(100_000),
				});
				const poolReceipt = yield* client.RegisterRunnerPool(stationId, {
					spec: LOCAL_POOL,
				});
				const observedReceipt = yield* client.ObserveJobDispatch(jobId, {
					stationId,
					requirements: {
						minutes: PositiveMinutes.make(3),
						needsDocker: true,
						isolationRequired: false,
						publicRepository: false,
					},
					deadlineSeconds: null,
				});
				const capacity = yield* client.FleetCapacityView.get(stationId, {
					atLeast: poolReceipt,
				});
				const audit = yield* client.RoutingAuditView.get(jobId, {
					atLeast: observedReceipt,
				});
				return { capacity, audit };
			}).pipe(Effect.scoped, Effect.provide(HttpWorld)),
		);

		expect(httpResult.capacity?.pools).toHaveLength(1);
		expect(httpResult.capacity?.pools[0]?.poolId).toBe(LOCAL_POOL.poolId);
		expect(httpResult.audit?._tag).not.toBe("Unobserved");
	});

	it("persists CiFleet state and materialized views across SQLite host restarts", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-ci-host-sqlite-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "ci-fleet.sqlite");
		const stationId = StationId.make("station-sqlite-1");

		const first = createNodeSqliteDriver({ path: dbPath });
		try {
			const FirstWorld = createCiFleetSqliteLayer(first, RunnerBackendStub);
			await Effect.runPromise(
				Effect.gen(function* () {
					const client = yield* CiFleetApi.clientInProcess;
					yield* client.ConfigureStationBudget(stationId, {
						ceilingMicros: NonNegativeMicros.make(80_000),
					});
					const receipt = yield* client.RegisterRunnerPool(stationId, {
						spec: LOCAL_POOL,
					});
					yield* client.FleetCapacityView.get(stationId, { atLeast: receipt });
				}).pipe(Effect.scoped, Effect.provide(FirstWorld)),
			);
		} finally {
			first.close();
		}

		const reopened = createNodeSqliteDriver({ path: dbPath });
		try {
			const ReopenedWorld = createCiFleetSqliteLayer(
				reopened,
				RunnerBackendStub,
			);
			const capacity = await Effect.runPromise(
				Effect.gen(function* () {
					const client = yield* CiFleetApi.clientInProcess;
					return yield* client.FleetCapacityView.get(stationId);
				}).pipe(Effect.scoped, Effect.provide(ReopenedWorld)),
			);

			expect(capacity).not.toBeNull();
			expect(capacity?.ceilingMicros).toBe(NonNegativeMicros.make(80_000));
			expect(capacity?.pools).toHaveLength(1);
			expect(capacity?.pools[0]?.activeJobs).toBe(NonNegativeCount.make(0));
		} finally {
			reopened.close();
		}
	});

	it("composes CiFleet with DomainRivet.layerDurableObjects via createCiFleetRivetLayer", () => {
		const buildLayer = (pool: Layer.Layer<PoolHost>) =>
			createCiFleetRivetLayer({
				name: "CiFleet",
				main: import.meta.url,
				handler: "CiFleetLive",
				pool,
				runnerBackend: RunnerBackendStub,
			});
		expect(buildLayer).toBeTypeOf("function");
	});

	it("persists CI leases in RivetKit SQLite, broadcasts events, and expires scheduled leases via setupTest", async (testCtx) => {
		const engine = await startLocalRivetTestEngine();
		const registry = createCiStationLeaseRegistry({
			endpoint: engine.endpoint,
			token: engine.token,
			httpHost: engine.httpHost,
			httpPort: engine.httpPort,
			startEngine: false,
			noWelcome: true,
			shutdown: { gracePeriodMs: 2_000, disableSignalHandlers: true },
		});

		try {
			const { client } = await setupTest(testCtx, registry);
			const leaseActor = client.stationLease.getOrCreate(["station-rivet-1"]);
			const conn = leaseActor.connect();
			const receivedEvents: CiStationLeaseEvent[] = [];
			conn.on("leaseUpdated", (payload: CiStationLeaseEvent) => {
				receivedEvents.push(payload);
			});

			try {
				const acquired = await conn.acquireLease({
					slotId: SlotId.make("slot-rivet-1"),
					jobId: JobDispatchId.make("job-rivet-1"),
					poolId: LOCAL_POOL.poolId,
					tier: "local",
					reservedMicros: NonNegativeMicros.make(5_000),
					ttlMs: 10_000,
				});
				const deduped = await conn.acquireLease({
					slotId: SlotId.make("slot-rivet-duplicate"),
					jobId: JobDispatchId.make("job-rivet-1"),
					poolId: LOCAL_POOL.poolId,
					tier: "local",
					reservedMicros: NonNegativeMicros.make(5_000),
					ttlMs: 10_000,
				});
				expect(deduped.slotId).toBe(acquired.slotId);

				const completed = await conn.completeLease({
					slotId: SlotId.make("slot-rivet-1"),
					settledMicros: NonNegativeMicros.make(3_000),
				});
				expect(completed?.status).toBe("completed");
				expect(completed?.settledMicros).toBe(3_000);

				await vi.waitFor(() => {
					expect(
						receivedEvents.some(
							(entry) =>
								entry.action === "completed" &&
								entry.lease.slotId === "slot-rivet-1",
						),
					).toBe(true);
				});

				await conn.acquireLease({
					slotId: SlotId.make("slot-rivet-expiring"),
					jobId: JobDispatchId.make("job-rivet-expiring"),
					poolId: LOCAL_POOL.poolId,
					tier: "local",
					reservedMicros: NonNegativeMicros.make(1_000),
					ttlMs: 60,
				});

				await expect
					.poll(
						async () => {
							const leases = await conn.listLeases();
							return leases.find(
								(entry) => entry.slotId === "slot-rivet-expiring",
							)?.status;
						},
						{ timeout: 5_000, interval: 25 },
					)
					.toBe("expired");
			} finally {
				await conn.dispose();
			}
		} finally {
			await registry.shutdown();
			await engine.stop();
		}
	}, 20_000);
});
