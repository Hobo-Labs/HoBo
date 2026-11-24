import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import {
	BalancedSlotReleased,
	BalancedSlotReserved,
	BindRunnerStart,
	BudgetCeilingExceeded,
	CiFleet,
	CiFleetApi,
	CiFleetHandlers,
	CompleteJobDispatch,
	DispatchJob,
	FleetCapacityView,
	JobDispatch,
	JobDispatchCompleted,
	JobDispatchExpired,
	JobDispatchFailed,
	JobDispatchId,
	JobDispatchObserved,
	JobNotQueued,
	ObserveJobDispatch,
	RoutingAuditView,
	RunnerBackend,
	RunnerCapacityExhausted,
	RunnerPoolId,
	RunnerPoolRegistered,
	RunnerStartBound,
	SlotId,
	StartBindingConflict,
	StationBudgetConfigured,
	StationFleet,
	StationId,
} from "../src/domain/index.js";

const story = Story.make(CiFleet, {
	layer: CiFleetHandlers,
	stub: [RunnerBackend],
});

const station = StationFleet.ref(StationId.make("station-main"));

const LOCAL_POOL = {
	poolId: RunnerPoolId.make("local-devbox"),
	tier: "local" as const,
	role: "primary" as const,
	runsOn: "hobo-local-host",
	concurrency: 2,
	costPerMinuteMicros: 0,
	payer: "local",
	payerBudgetMicros: null,
	isolated: false,
	docker: true,
	publicRepositories: false,
};

const HOSTINGER_POOL = {
	poolId: RunnerPoolId.make("hostinger-vps-1"),
	tier: "hostinger" as const,
	role: "primary" as const,
	runsOn: "hobo-hostinger",
	concurrency: 2,
	costPerMinuteMicros: 0,
	payer: "hostinger",
	payerBudgetMicros: null,
	isolated: true,
	docker: true,
	publicRepositories: true,
};

const AGENT37_POOL = {
	poolId: RunnerPoolId.make("agent37-vm"),
	tier: "agent37" as const,
	role: "overflow" as const,
	runsOn: "hobo-agent37",
	concurrency: 2,
	costPerMinuteMicros: 2_000,
	payer: "agent37",
	payerBudgetMicros: 50_000,
	isolated: true,
	docker: true,
	publicRepositories: true,
};

const GITHUB_POOL = {
	poolId: RunnerPoolId.make("github-hosted"),
	tier: "github" as const,
	role: "last-resort" as const,
	runsOn: "ubuntu-24.04",
	concurrency: 10,
	costPerMinuteMicros: 8_000,
	payer: "github",
	payerBudgetMicros: 200_000,
	isolated: true,
	docker: true,
	publicRepositories: true,
};

const PRIVATE_JOB = {
	minutes: 5,
	needsDocker: true,
	isolationRequired: false,
	publicRepository: false,
};

const PUBLIC_ISOLATED_JOB = {
	minutes: 5,
	needsDocker: true,
	isolationRequired: true,
	publicRepository: true,
};

function registeredAllTiers() {
	return Story.given(
		station,
		new StationBudgetConfigured({ ceilingMicros: 150_000 }),
		new RunnerPoolRegistered({ spec: LOCAL_POOL }),
		new RunnerPoolRegistered({ spec: HOSTINGER_POOL }),
		new RunnerPoolRegistered({ spec: AGENT37_POOL }),
		new RunnerPoolRegistered({ spec: GITHUB_POOL }),
	);
}

describe("CiFleet Alchemy Domain model", () => {
	it("passes Domain.verify with zero structural definition errors", () => {
		expect(Domain.verify(CiFleet)).toEqual([]);
	});

	it("balances jobs across local, Hostinger, Agent37, and GitHub-hosted pools by utilization and tier", async () => {
		const job1 = JobDispatch.ref(JobDispatchId.make("job-1"));
		const job2 = JobDispatch.ref(JobDispatchId.make("job-2"));
		const job3 = JobDispatch.ref(JobDispatchId.make("job-3"));
		const job4 = JobDispatch.ref(JobDispatchId.make("job-4"));
		const job5 = JobDispatch.ref(JobDispatchId.make("job-5"));
		const job6 = JobDispatch.ref(JobDispatchId.make("job-6"));
		const job7 = JobDispatch.ref(JobDispatchId.make("job-7"));

		await Effect.runPromise(
			story(
				registeredAllTiers(),
				Story.when(
					job1,
					new ObserveJobDispatch({
						stationId: station.id,
						requirements: PRIVATE_JOB,
						deadlineSeconds: null,
					}),
				),
				Story.then(
					job1,
					new JobDispatchObserved({
						stationId: station.id,
						requirements: PRIVATE_JOB,
						deadlineSeconds: null,
					}),
				),
				Story.then(
					station,
					new BalancedSlotReserved({
						slotId: SlotId.make("slot-1-local-devbox"),
						jobId: job1.id,
						poolId: LOCAL_POOL.poolId,
						tier: "local",
						runsOn: LOCAL_POOL.runsOn,
						payer: "local",
						reservedMicros: 0,
					}),
				),
				Story.call(RunnerBackend.provisionRunner, {
					poolId: LOCAL_POOL.poolId,
					tier: "local",
					jobId: job1.id,
				}),
				Story.succeed(RunnerBackend.provisionRunner, {
					externalRunnerId: "local-runner-1",
				}),
				Story.then(
					job1,
					new RunnerStartBound({
						stationId: station.id,
						poolId: LOCAL_POOL.poolId,
						tier: "local",
						slotId: SlotId.make("slot-1-local-devbox"),
						runsOn: LOCAL_POOL.runsOn,
						externalRunnerId: "local-runner-1",
						attempts: 1,
					}),
				),
				Story.when(
					job2,
					new ObserveJobDispatch({
						stationId: station.id,
						requirements: PRIVATE_JOB,
						deadlineSeconds: null,
					}),
				),
				Story.then(
					job2,
					new JobDispatchObserved({
						stationId: station.id,
						requirements: PRIVATE_JOB,
						deadlineSeconds: null,
					}),
				),
				Story.then(
					station,
					new BalancedSlotReserved({
						slotId: SlotId.make("slot-2-hostinger-vps-1"),
						jobId: job2.id,
						poolId: HOSTINGER_POOL.poolId,
						tier: "hostinger",
						runsOn: HOSTINGER_POOL.runsOn,
						payer: "hostinger",
						reservedMicros: 0,
					}),
				),
				Story.call(RunnerBackend.provisionRunner, {
					poolId: HOSTINGER_POOL.poolId,
					tier: "hostinger",
					jobId: job2.id,
				}),
				Story.succeed(RunnerBackend.provisionRunner, {
					externalRunnerId: "hostinger-runner-1",
				}),
				Story.then(
					job2,
					new RunnerStartBound({
						stationId: station.id,
						poolId: HOSTINGER_POOL.poolId,
						tier: "hostinger",
						slotId: SlotId.make("slot-2-hostinger-vps-1"),
						runsOn: HOSTINGER_POOL.runsOn,
						externalRunnerId: "hostinger-runner-1",
						attempts: 1,
					}),
				),
				Story.when(
					job3,
					new ObserveJobDispatch({
						stationId: station.id,
						requirements: PRIVATE_JOB,
						deadlineSeconds: null,
					}),
				),
				Story.then(
					job3,
					new JobDispatchObserved({
						stationId: station.id,
						requirements: PRIVATE_JOB,
						deadlineSeconds: null,
					}),
				),
				Story.then(
					station,
					new BalancedSlotReserved({
						slotId: SlotId.make("slot-3-local-devbox"),
						jobId: job3.id,
						poolId: LOCAL_POOL.poolId,
						tier: "local",
						runsOn: LOCAL_POOL.runsOn,
						payer: "local",
						reservedMicros: 0,
					}),
				),
				Story.call(RunnerBackend.provisionRunner, {
					poolId: LOCAL_POOL.poolId,
					tier: "local",
					jobId: job3.id,
				}),
				Story.succeed(RunnerBackend.provisionRunner, {
					externalRunnerId: "local-runner-2",
				}),
				Story.then(
					job3,
					new RunnerStartBound({
						stationId: station.id,
						poolId: LOCAL_POOL.poolId,
						tier: "local",
						slotId: SlotId.make("slot-3-local-devbox"),
						runsOn: LOCAL_POOL.runsOn,
						externalRunnerId: "local-runner-2",
						attempts: 1,
					}),
				),
				Story.when(
					job4,
					new ObserveJobDispatch({
						stationId: station.id,
						requirements: PRIVATE_JOB,
						deadlineSeconds: null,
					}),
				),
				Story.then(
					job4,
					new JobDispatchObserved({
						stationId: station.id,
						requirements: PRIVATE_JOB,
						deadlineSeconds: null,
					}),
				),
				Story.then(
					station,
					new BalancedSlotReserved({
						slotId: SlotId.make("slot-4-hostinger-vps-1"),
						jobId: job4.id,
						poolId: HOSTINGER_POOL.poolId,
						tier: "hostinger",
						runsOn: HOSTINGER_POOL.runsOn,
						payer: "hostinger",
						reservedMicros: 0,
					}),
				),
				Story.call(RunnerBackend.provisionRunner, {
					poolId: HOSTINGER_POOL.poolId,
					tier: "hostinger",
					jobId: job4.id,
				}),
				Story.succeed(RunnerBackend.provisionRunner, {
					externalRunnerId: "hostinger-runner-2",
				}),
				Story.then(
					job4,
					new RunnerStartBound({
						stationId: station.id,
						poolId: HOSTINGER_POOL.poolId,
						tier: "hostinger",
						slotId: SlotId.make("slot-4-hostinger-vps-1"),
						runsOn: HOSTINGER_POOL.runsOn,
						externalRunnerId: "hostinger-runner-2",
						attempts: 1,
					}),
				),
				Story.when(
					job5,
					new ObserveJobDispatch({
						stationId: station.id,
						requirements: PRIVATE_JOB,
						deadlineSeconds: null,
					}),
				),
				Story.then(
					job5,
					new JobDispatchObserved({
						stationId: station.id,
						requirements: PRIVATE_JOB,
						deadlineSeconds: null,
					}),
				),
				Story.then(
					station,
					new BalancedSlotReserved({
						slotId: SlotId.make("slot-5-agent37-vm"),
						jobId: job5.id,
						poolId: AGENT37_POOL.poolId,
						tier: "agent37",
						runsOn: AGENT37_POOL.runsOn,
						payer: "agent37",
						reservedMicros: 10_000,
					}),
				),
				Story.call(RunnerBackend.provisionRunner, {
					poolId: AGENT37_POOL.poolId,
					tier: "agent37",
					jobId: job5.id,
				}),
				Story.succeed(RunnerBackend.provisionRunner, {
					externalRunnerId: "agent37-runner-1",
				}),
				Story.then(
					job5,
					new RunnerStartBound({
						stationId: station.id,
						poolId: AGENT37_POOL.poolId,
						tier: "agent37",
						slotId: SlotId.make("slot-5-agent37-vm"),
						runsOn: AGENT37_POOL.runsOn,
						externalRunnerId: "agent37-runner-1",
						attempts: 1,
					}),
				),
				Story.when(
					job6,
					new ObserveJobDispatch({
						stationId: station.id,
						requirements: PRIVATE_JOB,
						deadlineSeconds: null,
					}),
				),
				Story.then(
					job6,
					new JobDispatchObserved({
						stationId: station.id,
						requirements: PRIVATE_JOB,
						deadlineSeconds: null,
					}),
				),
				Story.then(
					station,
					new BalancedSlotReserved({
						slotId: SlotId.make("slot-6-agent37-vm"),
						jobId: job6.id,
						poolId: AGENT37_POOL.poolId,
						tier: "agent37",
						runsOn: AGENT37_POOL.runsOn,
						payer: "agent37",
						reservedMicros: 10_000,
					}),
				),
				Story.call(RunnerBackend.provisionRunner, {
					poolId: AGENT37_POOL.poolId,
					tier: "agent37",
					jobId: job6.id,
				}),
				Story.succeed(RunnerBackend.provisionRunner, {
					externalRunnerId: "agent37-runner-2",
				}),
				Story.then(
					job6,
					new RunnerStartBound({
						stationId: station.id,
						poolId: AGENT37_POOL.poolId,
						tier: "agent37",
						slotId: SlotId.make("slot-6-agent37-vm"),
						runsOn: AGENT37_POOL.runsOn,
						externalRunnerId: "agent37-runner-2",
						attempts: 1,
					}),
				),
				Story.when(
					job7,
					new ObserveJobDispatch({
						stationId: station.id,
						requirements: PRIVATE_JOB,
						deadlineSeconds: null,
					}),
				),
				Story.then(
					job7,
					new JobDispatchObserved({
						stationId: station.id,
						requirements: PRIVATE_JOB,
						deadlineSeconds: null,
					}),
				),
				Story.then(
					station,
					new BalancedSlotReserved({
						slotId: SlotId.make("slot-7-github-hosted"),
						jobId: job7.id,
						poolId: GITHUB_POOL.poolId,
						tier: "github",
						runsOn: GITHUB_POOL.runsOn,
						payer: "github",
						reservedMicros: 40_000,
					}),
				),
				Story.call(RunnerBackend.provisionRunner, {
					poolId: GITHUB_POOL.poolId,
					tier: "github",
					jobId: job7.id,
				}),
				Story.succeed(RunnerBackend.provisionRunner, {
					externalRunnerId: "gh-runner-1",
				}),
				Story.then(
					job7,
					new RunnerStartBound({
						stationId: station.id,
						poolId: GITHUB_POOL.poolId,
						tier: "github",
						slotId: SlotId.make("slot-7-github-hosted"),
						runsOn: GITHUB_POOL.runsOn,
						externalRunnerId: "gh-runner-1",
						attempts: 1,
					}),
				),
				Story.view(FleetCapacityView, station, {
					exposureMicros: 60_000,
				}),
				Story.view(RoutingAuditView, job7, {
					status: "bound",
					tier: "github",
					poolId: GITHUB_POOL.poolId,
					attempts: 1,
				}),
			),
		);
	});

	it("compensates reserved slot and fails over from Hostinger to Agent37 to GitHub-hosted on capacity exhaustion", async () => {
		const job = JobDispatch.ref(JobDispatchId.make("job-failover"));

		await Effect.runPromise(
			story(
				registeredAllTiers(),
				Story.when(
					job,
					new ObserveJobDispatch({
						stationId: station.id,
						requirements: PUBLIC_ISOLATED_JOB,
						deadlineSeconds: null,
					}),
				),
				Story.then(
					job,
					new JobDispatchObserved({
						stationId: station.id,
						requirements: PUBLIC_ISOLATED_JOB,
						deadlineSeconds: null,
					}),
				),
				Story.then(
					station,
					new BalancedSlotReserved({
						slotId: SlotId.make("slot-1-hostinger-vps-1"),
						jobId: job.id,
						poolId: HOSTINGER_POOL.poolId,
						tier: "hostinger",
						runsOn: HOSTINGER_POOL.runsOn,
						payer: "hostinger",
						reservedMicros: 0,
					}),
				),
				Story.call(RunnerBackend.provisionRunner, {
					poolId: HOSTINGER_POOL.poolId,
					tier: "hostinger",
				}),
				Story.fail(
					RunnerBackend.provisionRunner,
					new RunnerCapacityExhausted({
						poolId: HOSTINGER_POOL.poolId,
						reason: "vps-saturated",
					}),
				),
				Story.then(
					station,
					new BalancedSlotReleased({
						slotId: SlotId.make("slot-1-hostinger-vps-1"),
						jobId: job.id,
						poolId: HOSTINGER_POOL.poolId,
						payer: "hostinger",
						reservedMicros: 0,
						settledMicros: 0,
					}),
					new BalancedSlotReserved({
						slotId: SlotId.make("slot-2-agent37-vm"),
						jobId: job.id,
						poolId: AGENT37_POOL.poolId,
						tier: "agent37",
						runsOn: AGENT37_POOL.runsOn,
						payer: "agent37",
						reservedMicros: 10_000,
					}),
				),
				Story.call(RunnerBackend.provisionRunner, {
					poolId: AGENT37_POOL.poolId,
					tier: "agent37",
				}),
				Story.fail(
					RunnerBackend.provisionRunner,
					new RunnerCapacityExhausted({
						poolId: AGENT37_POOL.poolId,
						reason: "quota-busy",
					}),
				),
				Story.then(
					station,
					new BalancedSlotReleased({
						slotId: SlotId.make("slot-2-agent37-vm"),
						jobId: job.id,
						poolId: AGENT37_POOL.poolId,
						payer: "agent37",
						reservedMicros: 10_000,
						settledMicros: 0,
					}),
					new BalancedSlotReserved({
						slotId: SlotId.make("slot-3-github-hosted"),
						jobId: job.id,
						poolId: GITHUB_POOL.poolId,
						tier: "github",
						runsOn: GITHUB_POOL.runsOn,
						payer: "github",
						reservedMicros: 40_000,
					}),
				),
				Story.call(RunnerBackend.provisionRunner, {
					poolId: GITHUB_POOL.poolId,
					tier: "github",
				}),
				Story.succeed(RunnerBackend.provisionRunner, {
					externalRunnerId: "gh-runner-fallback",
				}),
				Story.then(
					job,
					new RunnerStartBound({
						stationId: station.id,
						poolId: GITHUB_POOL.poolId,
						tier: "github",
						slotId: SlotId.make("slot-3-github-hosted"),
						runsOn: GITHUB_POOL.runsOn,
						externalRunnerId: "gh-runner-fallback",
						attempts: 3,
					}),
				),
				Story.view(FleetCapacityView, station, {
					exposureMicros: 40_000,
				}),
				Story.when(
					job,
					new CompleteJobDispatch({
						settledMicros: 24_000,
						conclusion: "succeeded",
					}),
				),
				Story.then(
					job,
					new JobDispatchCompleted({
						stationId: station.id,
						slotId: SlotId.make("slot-3-github-hosted"),
						settledMicros: 24_000,
						conclusion: "succeeded",
					}),
				),
				Story.call(RunnerBackend.releaseRunner, {
					stationId: station.id,
					slotId: SlotId.make("slot-3-github-hosted"),
				}),
				Story.succeed(RunnerBackend.releaseRunner, { released: true }),
				Story.then(
					station,
					new BalancedSlotReleased({
						slotId: SlotId.make("slot-3-github-hosted"),
						jobId: job.id,
						poolId: GITHUB_POOL.poolId,
						payer: "github",
						reservedMicros: 40_000,
						settledMicros: 24_000,
					}),
				),
				Story.view(FleetCapacityView, station, {
					exposureMicros: 24_000,
				}),
				Story.view(RoutingAuditView, job, {
					status: "completed",
					settledMicros: 24_000,
				}),
			),
		);
	});

	it("rejects conflicting start rebinds and enforces budget ceiling failures", async () => {
		const job = JobDispatch.ref(JobDispatchId.make("job-conflict"));
		const overBudgetJob = JobDispatch.ref(
			JobDispatchId.make("job-over-budget"),
		);

		await Effect.runPromise(
			story(
				Story.given(
					station,
					new StationBudgetConfigured({ ceilingMicros: 5_000 }),
					new RunnerPoolRegistered({ spec: AGENT37_POOL }),
				),
				Story.given(
					job,
					new JobDispatchObserved({
						stationId: station.id,
						requirements: PRIVATE_JOB,
						deadlineSeconds: null,
					}),
					new RunnerStartBound({
						stationId: station.id,
						poolId: AGENT37_POOL.poolId,
						tier: "agent37",
						slotId: SlotId.make("slot-original"),
						runsOn: AGENT37_POOL.runsOn,
						externalRunnerId: "runner-original",
						attempts: 1,
					}),
				),
				Story.when(
					job,
					new BindRunnerStart({
						poolId: AGENT37_POOL.poolId,
						tier: "agent37",
						slotId: SlotId.make("slot-hijack"),
						runsOn: AGENT37_POOL.runsOn,
						externalRunnerId: "runner-hijack",
						attempts: 2,
					}),
				),
				Story.rejected(
					new StartBindingConflict({
						boundSlotId: SlotId.make("slot-original"),
						boundPoolId: AGENT37_POOL.poolId,
						attemptedSlotId: SlotId.make("slot-hijack"),
					}),
				),
				Story.when(
					overBudgetJob,
					new ObserveJobDispatch({
						stationId: station.id,
						requirements: PRIVATE_JOB,
						deadlineSeconds: null,
					}),
				),
				Story.then(
					overBudgetJob,
					new JobDispatchObserved({
						stationId: station.id,
						requirements: PRIVATE_JOB,
						deadlineSeconds: null,
					}),
					new JobDispatchFailed({
						reason: "BudgetCeilingExceeded",
					}),
				),
				Story.saga(DispatchJob, overBudgetJob, {
					_tag: "Rejected",
					rejection: new BudgetCeilingExceeded({
						exposureMicros: 0,
						requestedMicros: 10_000,
						ceilingMicros: 5_000,
					}),
				}),
			),
		);
	});

	it("expires queued jobs when queue deadline elapses and serves in-process CiFleetApi", async () => {
		const expiredJob = JobDispatch.ref(JobDispatchId.make("job-deadline"));
		const slowStory = Story.make(CiFleet, {
			layer: CiFleetHandlers,
			stub: [RunnerBackend],
		});

		await Effect.runPromise(
			slowStory(
				Story.clock("2026-11-24T00:00:00Z"),
				Story.given(station, new RunnerPoolRegistered({ spec: LOCAL_POOL })),
				Story.when(
					expiredJob,
					new ObserveJobDispatch({
						stationId: station.id,
						requirements: PRIVATE_JOB,
						deadlineSeconds: 30,
					}),
				),
				Story.then(
					expiredJob,
					new JobDispatchObserved({
						stationId: station.id,
						requirements: PRIVATE_JOB,
						deadlineSeconds: 30,
					}),
				),
				Story.then(
					station,
					new BalancedSlotReserved({
						slotId: SlotId.make("slot-1-local-devbox"),
						jobId: expiredJob.id,
						poolId: LOCAL_POOL.poolId,
						tier: "local",
						runsOn: LOCAL_POOL.runsOn,
						payer: "local",
						reservedMicros: 0,
					}),
				),
				Story.call(RunnerBackend.provisionRunner, {
					poolId: LOCAL_POOL.poolId,
				}),
				Story.advance("31 seconds"),
				Story.then(
					expiredJob,
					new JobDispatchExpired({ reason: "queue-deadline-elapsed" }),
				),
				Story.succeed(RunnerBackend.provisionRunner, {
					externalRunnerId: "late-runner",
				}),
				Story.then(
					station,
					new BalancedSlotReleased({
						slotId: SlotId.make("slot-1-local-devbox"),
						jobId: expiredJob.id,
						poolId: LOCAL_POOL.poolId,
						payer: "local",
						reservedMicros: 0,
						settledMicros: 0,
					}),
				),
				Story.saga(DispatchJob, expiredJob, {
					_tag: "Rejected",
					rejection: new JobNotQueued({ currentState: "Expired" }),
				}),
			),
		);

		const RunnerBackendStub = RunnerBackend.toLayer(
			Effect.succeed({
				provisionRunner: ({ slotId }) =>
					Effect.succeed({ externalRunnerId: `ext-${slotId}` }),
				releaseRunner: () => Effect.succeed({ released: true }),
			}),
		);

		const World = CiFleet.layer(CiFleetHandlers).pipe(
			Layer.provide(Layer.mergeAll(Domain.InMemory, RunnerBackendStub)),
		);

		const capacity = await Effect.runPromise(
			Effect.gen(function* () {
				const client = yield* CiFleetApi.clientInProcess;
				yield* client.ConfigureStationBudget(station.id, {
					ceilingMicros: 100_000,
				});
				yield* client.RegisterRunnerPool(station.id, { spec: LOCAL_POOL });
				const receipt = yield* client.SetRunnerPoolHealth(station.id, {
					poolId: LOCAL_POOL.poolId,
					health: "healthy",
					enabled: true,
				});
				return yield* client.FleetCapacityView.get(station.id, {
					atLeast: receipt,
				});
			}).pipe(Effect.scoped, Effect.provide(World)),
		);

		expect(capacity?.pools).toHaveLength(1);
		expect(capacity?.pools[0]?.poolId).toBe(LOCAL_POOL.poolId);
	});
});
