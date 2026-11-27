import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
	BalancedSlotReleased,
	BalancedSlotReserved,
	BindRunnerStart,
	BudgetCeilingBelowExposure,
	BudgetCeilingExceeded,
	CiFleet,
	CiFleetHandlers,
	CompleteJobDispatch,
	ConfigureStationBudget,
	DispatchJob,
	ExternalRunnerId,
	FleetCapacityView,
	JobDispatch,
	JobDispatchCompleted,
	JobDispatchExpired,
	JobDispatchFailed,
	JobDispatchId,
	JobDispatchObserved,
	JobNotQueued,
	JobRequirements,
	NonEmptyReason,
	NonNegativeCount,
	NonNegativeMicros,
	ObserveJobDispatch,
	PayerId,
	PositiveAttempts,
	PositiveConcurrency,
	PositiveMinutes,
	PositiveSeconds,
	type RoutingAuditState,
	RoutingAuditView,
	RunnerBackend,
	RunnerCapacityExhausted,
	RunnerLabel,
	RunnerPoolId,
	RunnerPoolRegistered,
	RunnerPoolSpec,
	RunnerReleaseFailed,
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
	runnerLabel: RunnerLabel.make("hobo-local-host"),
	concurrency: PositiveConcurrency.make(2),
	costPerMinuteMicros: NonNegativeMicros.make(0),
	payer: PayerId.make("local"),
	payerBudgetMicros: null,
	isolated: false,
	docker: true,
	publicRepositories: false,
};

const HOSTINGER_POOL = {
	poolId: RunnerPoolId.make("hostinger-vps-1"),
	tier: "hostinger" as const,
	role: "primary" as const,
	runnerLabel: RunnerLabel.make("hobo-hostinger"),
	concurrency: PositiveConcurrency.make(2),
	costPerMinuteMicros: NonNegativeMicros.make(0),
	payer: PayerId.make("hostinger"),
	payerBudgetMicros: null,
	isolated: true,
	docker: true,
	publicRepositories: true,
};

const AGENT37_POOL = {
	poolId: RunnerPoolId.make("agent37-vm"),
	tier: "agent37" as const,
	role: "overflow" as const,
	runnerLabel: RunnerLabel.make("hobo-agent37"),
	concurrency: PositiveConcurrency.make(2),
	costPerMinuteMicros: NonNegativeMicros.make(2_000),
	payer: PayerId.make("agent37"),
	payerBudgetMicros: NonNegativeMicros.make(50_000),
	isolated: true,
	docker: true,
	publicRepositories: true,
};

const HOSTED_POOL = {
	poolId: RunnerPoolId.make("hosted-fallback"),
	tier: "hosted" as const,
	role: "last-resort" as const,
	runnerLabel: RunnerLabel.make("hosted-linux"),
	concurrency: PositiveConcurrency.make(10),
	costPerMinuteMicros: NonNegativeMicros.make(8_000),
	payer: PayerId.make("hosted"),
	payerBudgetMicros: NonNegativeMicros.make(200_000),
	isolated: true,
	docker: true,
	publicRepositories: true,
};

const PRIVATE_JOB = {
	minutes: PositiveMinutes.make(5),
	needsDocker: true,
	isolationRequired: false,
	publicRepository: false,
};

const PUBLIC_ISOLATED_JOB = {
	minutes: PositiveMinutes.make(5),
	needsDocker: true,
	isolationRequired: true,
	publicRepository: true,
};

function registeredAllTiers() {
	return Story.given(
		station,
		new StationBudgetConfigured({
			ceilingMicros: NonNegativeMicros.make(150_000),
		}),
		new RunnerPoolRegistered({ spec: LOCAL_POOL }),
		new RunnerPoolRegistered({ spec: HOSTINGER_POOL }),
		new RunnerPoolRegistered({ spec: AGENT37_POOL }),
		new RunnerPoolRegistered({ spec: HOSTED_POOL }),
	);
}

type RunnerBackendService = Layer.Success<
	ReturnType<typeof RunnerBackend.toLayer>
>;

function runRunnerBackendConformance(
	adapterName: string,
	layer: Layer.Layer<RunnerBackendService>,
) {
	describe(`RunnerBackend adapter conformance: ${adapterName}`, () => {
		it("provisions and releases a runner through the typed ExternalSystem contract", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const backend = yield* RunnerBackend;
					const provisioned = yield* backend.provisionRunner({
						stationId: station.id,
						jobId: JobDispatchId.make("job-conformance-1"),
						poolId: LOCAL_POOL.poolId,
						tier: LOCAL_POOL.tier,
						runnerLabel: LOCAL_POOL.runnerLabel,
						slotId: SlotId.make("slot-conformance-1"),
					});
					const released = yield* backend.releaseRunner({
						stationId: station.id,
						slotId: SlotId.make("slot-conformance-1"),
					});
					return { provisioned, released };
				}).pipe(Effect.provide(layer)),
			);

			expect(result.provisioned.externalRunnerId.length).toBeGreaterThan(0);
			expect(result.released.released).toBe(true);
		});
	});
}

describe("CiFleet Alchemy Domain model", () => {
	it("passes Domain.verify with zero structural definition errors", () => {
		expect(Domain.verify(CiFleet)).toEqual([]);
	});

	it("enforces branded domain types and discriminated views at compile time and schema decode boundaries", () => {
		const checkCompileTimeConstraints = (audit: RoutingAuditState) => {
			// @ts-expect-error raw string is not a branded StationId
			const badStation: StationId = "station-raw";
			// @ts-expect-error raw number is not a branded NonNegativeMicros
			const badMicros: NonNegativeMicros = 100;
			// @ts-expect-error raw number is not a branded PositiveMinutes
			const badMinutes: PositiveMinutes = 5;
			// @ts-expect-error invalid status tag is rejected by closed JobDispatchStatusTag
			const badRejection = new JobNotQueued({ currentState: "Unknown" });
			// @ts-expect-error poolId does not exist on unnarrowed RoutingAuditState union
			const unnarrowedPool = audit.poolId;
			return [badStation, badMicros, badMinutes, badRejection, unnarrowedPool];
		};
		expect(checkCompileTimeConstraints).toBeTypeOf("function");

		const decodeMicros = Schema.decodeUnknownExit(NonNegativeMicros);
		const decodePoolSpec = Schema.decodeUnknownExit(RunnerPoolSpec);
		const decodeJobReq = Schema.decodeUnknownExit(JobRequirements);
		const decodeSeconds = Schema.decodeUnknownExit(PositiveSeconds);

		expect(Exit.isFailure(decodeMicros(-1))).toBe(true);
		expect(Exit.isFailure(decodeSeconds(0))).toBe(true);
		expect(
			Exit.isFailure(
				decodeJobReq({
					minutes: 0,
					needsDocker: true,
					isolationRequired: false,
					publicRepository: false,
				}),
			),
		).toBe(true);
		expect(
			Exit.isFailure(
				decodePoolSpec({
					...LOCAL_POOL,
					concurrency: 0,
				}),
			),
		).toBe(true);
	});

	it("balances jobs across local, Hostinger, Agent37, and hosted pools by utilization and tier", async () => {
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
						runnerLabel: LOCAL_POOL.runnerLabel,
						payer: LOCAL_POOL.payer,
						reservedMicros: NonNegativeMicros.make(0),
					}),
				),
				Story.call(RunnerBackend.provisionRunner, {
					poolId: LOCAL_POOL.poolId,
					tier: "local",
					slotId: SlotId.make("slot-1-local-devbox"),
				}),
				Story.succeed(RunnerBackend.provisionRunner, {
					externalRunnerId: ExternalRunnerId.make("local-1"),
				}),
				Story.then(
					job1,
					new RunnerStartBound({
						stationId: station.id,
						poolId: LOCAL_POOL.poolId,
						tier: "local",
						slotId: SlotId.make("slot-1-local-devbox"),
						runnerLabel: LOCAL_POOL.runnerLabel,
						externalRunnerId: ExternalRunnerId.make("local-1"),
						attempts: PositiveAttempts.make(1),
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
						runnerLabel: HOSTINGER_POOL.runnerLabel,
						payer: HOSTINGER_POOL.payer,
						reservedMicros: NonNegativeMicros.make(0),
					}),
				),
				Story.call(RunnerBackend.provisionRunner, {
					poolId: HOSTINGER_POOL.poolId,
					tier: "hostinger",
					slotId: SlotId.make("slot-2-hostinger-vps-1"),
				}),
				Story.succeed(RunnerBackend.provisionRunner, {
					externalRunnerId: ExternalRunnerId.make("hostinger-1"),
				}),
				Story.then(
					job2,
					new RunnerStartBound({
						stationId: station.id,
						poolId: HOSTINGER_POOL.poolId,
						tier: "hostinger",
						slotId: SlotId.make("slot-2-hostinger-vps-1"),
						runnerLabel: HOSTINGER_POOL.runnerLabel,
						externalRunnerId: ExternalRunnerId.make("hostinger-1"),
						attempts: PositiveAttempts.make(1),
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
						runnerLabel: LOCAL_POOL.runnerLabel,
						payer: LOCAL_POOL.payer,
						reservedMicros: NonNegativeMicros.make(0),
					}),
				),
				Story.call(RunnerBackend.provisionRunner, {
					poolId: LOCAL_POOL.poolId,
					tier: "local",
					slotId: SlotId.make("slot-3-local-devbox"),
				}),
				Story.succeed(RunnerBackend.provisionRunner, {
					externalRunnerId: ExternalRunnerId.make("local-2"),
				}),
				Story.then(
					job3,
					new RunnerStartBound({
						stationId: station.id,
						poolId: LOCAL_POOL.poolId,
						tier: "local",
						slotId: SlotId.make("slot-3-local-devbox"),
						runnerLabel: LOCAL_POOL.runnerLabel,
						externalRunnerId: ExternalRunnerId.make("local-2"),
						attempts: PositiveAttempts.make(1),
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
						runnerLabel: HOSTINGER_POOL.runnerLabel,
						payer: HOSTINGER_POOL.payer,
						reservedMicros: NonNegativeMicros.make(0),
					}),
				),
				Story.call(RunnerBackend.provisionRunner, {
					poolId: HOSTINGER_POOL.poolId,
					tier: "hostinger",
					slotId: SlotId.make("slot-4-hostinger-vps-1"),
				}),
				Story.succeed(RunnerBackend.provisionRunner, {
					externalRunnerId: ExternalRunnerId.make("hostinger-2"),
				}),
				Story.then(
					job4,
					new RunnerStartBound({
						stationId: station.id,
						poolId: HOSTINGER_POOL.poolId,
						tier: "hostinger",
						slotId: SlotId.make("slot-4-hostinger-vps-1"),
						runnerLabel: HOSTINGER_POOL.runnerLabel,
						externalRunnerId: ExternalRunnerId.make("hostinger-2"),
						attempts: PositiveAttempts.make(1),
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
						runnerLabel: AGENT37_POOL.runnerLabel,
						payer: AGENT37_POOL.payer,
						reservedMicros: NonNegativeMicros.make(10_000),
					}),
				),
				Story.call(RunnerBackend.provisionRunner, {
					poolId: AGENT37_POOL.poolId,
					tier: "agent37",
					slotId: SlotId.make("slot-5-agent37-vm"),
				}),
				Story.succeed(RunnerBackend.provisionRunner, {
					externalRunnerId: ExternalRunnerId.make("agent37-1"),
				}),
				Story.then(
					job5,
					new RunnerStartBound({
						stationId: station.id,
						poolId: AGENT37_POOL.poolId,
						tier: "agent37",
						slotId: SlotId.make("slot-5-agent37-vm"),
						runnerLabel: AGENT37_POOL.runnerLabel,
						externalRunnerId: ExternalRunnerId.make("agent37-1"),
						attempts: PositiveAttempts.make(1),
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
						runnerLabel: AGENT37_POOL.runnerLabel,
						payer: AGENT37_POOL.payer,
						reservedMicros: NonNegativeMicros.make(10_000),
					}),
				),
				Story.call(RunnerBackend.provisionRunner, {
					poolId: AGENT37_POOL.poolId,
					tier: "agent37",
					slotId: SlotId.make("slot-6-agent37-vm"),
				}),
				Story.succeed(RunnerBackend.provisionRunner, {
					externalRunnerId: ExternalRunnerId.make("agent37-2"),
				}),
				Story.then(
					job6,
					new RunnerStartBound({
						stationId: station.id,
						poolId: AGENT37_POOL.poolId,
						tier: "agent37",
						slotId: SlotId.make("slot-6-agent37-vm"),
						runnerLabel: AGENT37_POOL.runnerLabel,
						externalRunnerId: ExternalRunnerId.make("agent37-2"),
						attempts: PositiveAttempts.make(1),
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
						slotId: SlotId.make("slot-7-hosted-fallback"),
						jobId: job7.id,
						poolId: HOSTED_POOL.poolId,
						tier: "hosted",
						runnerLabel: HOSTED_POOL.runnerLabel,
						payer: HOSTED_POOL.payer,
						reservedMicros: NonNegativeMicros.make(40_000),
					}),
				),
				Story.call(RunnerBackend.provisionRunner, {
					poolId: HOSTED_POOL.poolId,
					tier: "hosted",
					slotId: SlotId.make("slot-7-hosted-fallback"),
				}),
				Story.succeed(RunnerBackend.provisionRunner, {
					externalRunnerId: ExternalRunnerId.make("hosted-1"),
				}),
				Story.then(
					job7,
					new RunnerStartBound({
						stationId: station.id,
						poolId: HOSTED_POOL.poolId,
						tier: "hosted",
						slotId: SlotId.make("slot-7-hosted-fallback"),
						runnerLabel: HOSTED_POOL.runnerLabel,
						externalRunnerId: ExternalRunnerId.make("hosted-1"),
						attempts: PositiveAttempts.make(1),
					}),
				),
				Story.view(FleetCapacityView, station, {
					exposureMicros: NonNegativeMicros.make(60_000),
				}),
				Story.view(RoutingAuditView, job7, {
					_tag: "Bound",
					tier: "hosted",
					poolId: HOSTED_POOL.poolId,
					attempts: PositiveAttempts.make(1),
				}),
			),
		);
	});

	it("fails over across tiers with slot compensation and reconciles settled spend on completion", async () => {
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
						runnerLabel: HOSTINGER_POOL.runnerLabel,
						payer: HOSTINGER_POOL.payer,
						reservedMicros: NonNegativeMicros.make(0),
					}),
				),
				Story.call(RunnerBackend.provisionRunner, {
					poolId: HOSTINGER_POOL.poolId,
				}),
				Story.fail(
					RunnerBackend.provisionRunner,
					new RunnerCapacityExhausted({
						poolId: HOSTINGER_POOL.poolId,
						reason: NonEmptyReason.make("hostinger-busy"),
					}),
				),
				Story.then(
					station,
					new BalancedSlotReleased({
						slotId: SlotId.make("slot-1-hostinger-vps-1"),
						jobId: job.id,
						poolId: HOSTINGER_POOL.poolId,
						payer: HOSTINGER_POOL.payer,
						reservedMicros: NonNegativeMicros.make(0),
						settledMicros: NonNegativeMicros.make(0),
					}),
					new BalancedSlotReserved({
						slotId: SlotId.make("slot-2-agent37-vm"),
						jobId: job.id,
						poolId: AGENT37_POOL.poolId,
						tier: "agent37",
						runnerLabel: AGENT37_POOL.runnerLabel,
						payer: AGENT37_POOL.payer,
						reservedMicros: NonNegativeMicros.make(10_000),
					}),
				),
				Story.call(RunnerBackend.provisionRunner, {
					poolId: AGENT37_POOL.poolId,
				}),
				Story.fail(
					RunnerBackend.provisionRunner,
					new RunnerCapacityExhausted({
						poolId: AGENT37_POOL.poolId,
						reason: NonEmptyReason.make("agent37-quota"),
					}),
				),
				Story.then(
					station,
					new BalancedSlotReleased({
						slotId: SlotId.make("slot-2-agent37-vm"),
						jobId: job.id,
						poolId: AGENT37_POOL.poolId,
						payer: AGENT37_POOL.payer,
						reservedMicros: NonNegativeMicros.make(10_000),
						settledMicros: NonNegativeMicros.make(0),
					}),
					new BalancedSlotReserved({
						slotId: SlotId.make("slot-3-hosted-fallback"),
						jobId: job.id,
						poolId: HOSTED_POOL.poolId,
						tier: "hosted",
						runnerLabel: HOSTED_POOL.runnerLabel,
						payer: HOSTED_POOL.payer,
						reservedMicros: NonNegativeMicros.make(40_000),
					}),
				),
				Story.call(RunnerBackend.provisionRunner, {
					poolId: HOSTED_POOL.poolId,
				}),
				Story.succeed(RunnerBackend.provisionRunner, {
					externalRunnerId: ExternalRunnerId.make("gh-runner-99"),
				}),
				Story.then(
					job,
					new RunnerStartBound({
						stationId: station.id,
						poolId: HOSTED_POOL.poolId,
						tier: "hosted",
						slotId: SlotId.make("slot-3-hosted-fallback"),
						runnerLabel: HOSTED_POOL.runnerLabel,
						externalRunnerId: ExternalRunnerId.make("gh-runner-99"),
						attempts: PositiveAttempts.make(3),
					}),
				),
				Story.when(
					station,
					new ConfigureStationBudget({
						ceilingMicros: NonNegativeMicros.make(20_000),
					}),
				),
				Story.rejected(
					new BudgetCeilingBelowExposure({
						exposureMicros: NonNegativeMicros.make(40_000),
						ceilingMicros: NonNegativeMicros.make(20_000),
					}),
				),
				Story.when(
					job,
					new CompleteJobDispatch({
						settledMicros: NonNegativeMicros.make(24_000),
						conclusion: "succeeded",
					}),
				),
				Story.then(
					job,
					new JobDispatchCompleted({
						stationId: station.id,
						slotId: SlotId.make("slot-3-hosted-fallback"),
						settledMicros: NonNegativeMicros.make(24_000),
						conclusion: "succeeded",
					}),
				),
				Story.call(RunnerBackend.releaseRunner, {
					stationId: station.id,
					slotId: SlotId.make("slot-3-hosted-fallback"),
				}),
				Story.succeed(RunnerBackend.releaseRunner, { released: true }),
				Story.then(
					station,
					new BalancedSlotReleased({
						slotId: SlotId.make("slot-3-hosted-fallback"),
						jobId: job.id,
						poolId: HOSTED_POOL.poolId,
						payer: HOSTED_POOL.payer,
						reservedMicros: NonNegativeMicros.make(40_000),
						settledMicros: NonNegativeMicros.make(24_000),
					}),
				),
				Story.view(FleetCapacityView, station, {
					exposureMicros: NonNegativeMicros.make(24_000),
				}),
				Story.view(RoutingAuditView, job, {
					_tag: "Completed",
					tier: "hosted",
					attempts: PositiveAttempts.make(3),
					settledMicros: NonNegativeMicros.make(24_000),
					conclusion: "succeeded",
				}),
			),
		);
	});

	it("enforces hard station spend cap and start-binding immutability", async () => {
		const cappedJob = JobDispatch.ref(JobDispatchId.make("job-capped"));
		const boundJob = JobDispatch.ref(JobDispatchId.make("job-bound"));

		await Effect.runPromise(
			story(
				Story.given(
					station,
					new StationBudgetConfigured({
						ceilingMicros: NonNegativeMicros.make(10_000),
					}),
					new RunnerPoolRegistered({ spec: HOSTED_POOL }),
				),
				Story.when(
					cappedJob,
					new ObserveJobDispatch({
						stationId: station.id,
						requirements: PUBLIC_ISOLATED_JOB,
						deadlineSeconds: null,
					}),
				),
				Story.then(
					cappedJob,
					new JobDispatchObserved({
						stationId: station.id,
						requirements: PUBLIC_ISOLATED_JOB,
						deadlineSeconds: null,
					}),
				),
				Story.then(
					cappedJob,
					new JobDispatchFailed({
						reason: NonEmptyReason.make("BudgetCeilingExceeded"),
					}),
				),
				Story.saga(DispatchJob, cappedJob, {
					_tag: "Rejected",
					rejection: new BudgetCeilingExceeded({
						exposureMicros: NonNegativeMicros.make(0),
						requestedMicros: NonNegativeMicros.make(40_000),
						ceilingMicros: NonNegativeMicros.make(10_000),
					}),
				}),
				Story.view(RoutingAuditView, cappedJob, {
					_tag: "Failed",
					stationId: station.id,
					reason: NonEmptyReason.make("BudgetCeilingExceeded"),
				}),
				Story.given(
					boundJob,
					new JobDispatchObserved({
						stationId: station.id,
						requirements: PRIVATE_JOB,
						deadlineSeconds: null,
					}),
					new RunnerStartBound({
						stationId: station.id,
						poolId: LOCAL_POOL.poolId,
						tier: "local",
						slotId: SlotId.make("slot-1-local-devbox"),
						runnerLabel: LOCAL_POOL.runnerLabel,
						externalRunnerId: ExternalRunnerId.make("local-1"),
						attempts: PositiveAttempts.make(1),
					}),
				),
				Story.when(
					boundJob,
					new BindRunnerStart({
						poolId: HOSTED_POOL.poolId,
						tier: "hosted",
						slotId: SlotId.make("slot-2-hosted-fallback"),
						runnerLabel: HOSTED_POOL.runnerLabel,
						externalRunnerId: ExternalRunnerId.make("gh-2"),
						attempts: PositiveAttempts.make(2),
					}),
				),
				Story.rejected(
					new StartBindingConflict({
						boundSlotId: SlotId.make("slot-1-local-devbox"),
						boundPoolId: LOCAL_POOL.poolId,
						attemptedSlotId: SlotId.make("slot-2-hosted-fallback"),
					}),
				),
			),
		);
	});

	it("expires queued jobs when queue deadline elapses and compensates late provisioning", async () => {
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
						deadlineSeconds: PositiveSeconds.make(30),
					}),
				),
				Story.then(
					expiredJob,
					new JobDispatchObserved({
						stationId: station.id,
						requirements: PRIVATE_JOB,
						deadlineSeconds: PositiveSeconds.make(30),
					}),
				),
				Story.then(
					station,
					new BalancedSlotReserved({
						slotId: SlotId.make("slot-1-local-devbox"),
						jobId: expiredJob.id,
						poolId: LOCAL_POOL.poolId,
						tier: "local",
						runnerLabel: LOCAL_POOL.runnerLabel,
						payer: LOCAL_POOL.payer,
						reservedMicros: NonNegativeMicros.make(0),
					}),
				),
				Story.call(RunnerBackend.provisionRunner, {
					poolId: LOCAL_POOL.poolId,
				}),
				Story.advance("31 seconds"),
				Story.then(
					expiredJob,
					new JobDispatchExpired({
						reason: NonEmptyReason.make("queue-deadline-elapsed"),
						stationId: station.id,
						slotId: null,
					}),
				),
				Story.succeed(RunnerBackend.provisionRunner, {
					externalRunnerId: ExternalRunnerId.make("late-runner"),
				}),
				Story.then(
					station,
					new BalancedSlotReleased({
						slotId: SlotId.make("slot-1-local-devbox"),
						jobId: expiredJob.id,
						poolId: LOCAL_POOL.poolId,
						payer: LOCAL_POOL.payer,
						reservedMicros: NonNegativeMicros.make(0),
						settledMicros: NonNegativeMicros.make(0),
					}),
				),
				Story.saga(DispatchJob, expiredJob, {
					_tag: "Rejected",
					rejection: new JobNotQueued({ currentState: "Expired" }),
				}),
				Story.view(RoutingAuditView, expiredJob, {
					_tag: "Expired",
					stationId: station.id,
					reason: NonEmptyReason.make("queue-deadline-elapsed"),
				}),
				Story.view(FleetCapacityView, station, {
					pools: [
						{
							poolId: LOCAL_POOL.poolId,
							tier: "local",
							role: "primary",
							runnerLabel: LOCAL_POOL.runnerLabel,
							concurrency: LOCAL_POOL.concurrency,
							activeJobs: NonNegativeCount.make(0),
							dispatchedCount: NonNegativeCount.make(1),
							health: "healthy",
							enabled: true,
						},
					],
				}),
			),
		);
	});

	it("expires bound jobs at deadline and releases runner slot capacity", async () => {
		const boundDeadlineJob = JobDispatch.ref(
			JobDispatchId.make("job-bound-deadline"),
		);
		const deadlineStory = Story.make(CiFleet, {
			layer: CiFleetHandlers,
			stub: [RunnerBackend],
		});

		await Effect.runPromise(
			deadlineStory(
				Story.clock("2026-11-24T01:00:00Z"),
				Story.given(station, new RunnerPoolRegistered({ spec: LOCAL_POOL })),
				Story.when(
					boundDeadlineJob,
					new ObserveJobDispatch({
						stationId: station.id,
						requirements: PRIVATE_JOB,
						deadlineSeconds: PositiveSeconds.make(60),
					}),
				),
				Story.then(
					boundDeadlineJob,
					new JobDispatchObserved({
						stationId: station.id,
						requirements: PRIVATE_JOB,
						deadlineSeconds: PositiveSeconds.make(60),
					}),
				),
				Story.then(
					station,
					new BalancedSlotReserved({
						slotId: SlotId.make("slot-1-local-devbox"),
						jobId: boundDeadlineJob.id,
						poolId: LOCAL_POOL.poolId,
						tier: "local",
						runnerLabel: LOCAL_POOL.runnerLabel,
						payer: LOCAL_POOL.payer,
						reservedMicros: NonNegativeMicros.make(0),
					}),
				),
				Story.call(RunnerBackend.provisionRunner, {
					poolId: LOCAL_POOL.poolId,
				}),
				Story.succeed(RunnerBackend.provisionRunner, {
					externalRunnerId: ExternalRunnerId.make("bound-runner"),
				}),
				Story.then(
					boundDeadlineJob,
					new RunnerStartBound({
						stationId: station.id,
						poolId: LOCAL_POOL.poolId,
						tier: "local",
						slotId: SlotId.make("slot-1-local-devbox"),
						runnerLabel: LOCAL_POOL.runnerLabel,
						externalRunnerId: ExternalRunnerId.make("bound-runner"),
						attempts: PositiveAttempts.make(1),
					}),
				),
				Story.advance("61 seconds"),
				Story.call(RunnerBackend.releaseRunner, {
					stationId: station.id,
					slotId: SlotId.make("slot-1-local-devbox"),
				}),
				Story.succeed(RunnerBackend.releaseRunner, { released: true }),
				Story.then(
					boundDeadlineJob,
					new JobDispatchExpired({
						reason: NonEmptyReason.make("queue-deadline-elapsed"),
						stationId: station.id,
						slotId: SlotId.make("slot-1-local-devbox"),
					}),
				),
				Story.then(
					station,
					new BalancedSlotReleased({
						slotId: SlotId.make("slot-1-local-devbox"),
						jobId: boundDeadlineJob.id,
						poolId: LOCAL_POOL.poolId,
						payer: LOCAL_POOL.payer,
						reservedMicros: NonNegativeMicros.make(0),
						settledMicros: NonNegativeMicros.make(0),
					}),
				),
				Story.view(RoutingAuditView, boundDeadlineJob, {
					_tag: "Expired",
					stationId: station.id,
					reason: NonEmptyReason.make("queue-deadline-elapsed"),
				}),
			),
		);
	});

	it("surfaces releaseRunner failures instead of settling slot release", async () => {
		const failingJob = JobDispatch.ref(JobDispatchId.make("job-release-fail"));
		const slotId = SlotId.make("slot-1-local-devbox");
		const releaseReason = NonEmptyReason.make("runner-not-found");

		const exit = await Effect.runPromiseExit(
			story(
				Story.given(station, new RunnerPoolRegistered({ spec: LOCAL_POOL })),
				Story.when(
					failingJob,
					new ObserveJobDispatch({
						stationId: station.id,
						requirements: PRIVATE_JOB,
						deadlineSeconds: null,
					}),
				),
				Story.then(
					failingJob,
					new JobDispatchObserved({
						stationId: station.id,
						requirements: PRIVATE_JOB,
						deadlineSeconds: null,
					}),
				),
				Story.then(
					station,
					new BalancedSlotReserved({
						slotId,
						jobId: failingJob.id,
						poolId: LOCAL_POOL.poolId,
						tier: "local",
						runnerLabel: LOCAL_POOL.runnerLabel,
						payer: LOCAL_POOL.payer,
						reservedMicros: NonNegativeMicros.make(0),
					}),
				),
				Story.call(RunnerBackend.provisionRunner, {
					poolId: LOCAL_POOL.poolId,
				}),
				Story.succeed(RunnerBackend.provisionRunner, {
					externalRunnerId: ExternalRunnerId.make("runner-x"),
				}),
				Story.then(
					failingJob,
					new RunnerStartBound({
						stationId: station.id,
						poolId: LOCAL_POOL.poolId,
						tier: "local",
						slotId,
						runnerLabel: LOCAL_POOL.runnerLabel,
						externalRunnerId: ExternalRunnerId.make("runner-x"),
						attempts: PositiveAttempts.make(1),
					}),
				),
				Story.when(
					failingJob,
					new CompleteJobDispatch({
						settledMicros: NonNegativeMicros.make(0),
						conclusion: "succeeded",
					}),
				),
				Story.then(
					failingJob,
					new JobDispatchCompleted({
						stationId: station.id,
						slotId,
						settledMicros: NonNegativeMicros.make(0),
						conclusion: "succeeded",
					}),
				),
				Story.call(RunnerBackend.releaseRunner, {
					stationId: station.id,
					slotId,
				}),
				Story.fail(
					RunnerBackend.releaseRunner,
					new RunnerReleaseFailed({ slotId, reason: releaseReason }),
				),
			),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		if (exit._tag === "Failure") {
			expect(Cause.pretty(exit.cause)).toContain("RunnerReleaseFailed");
		}
	});

	runRunnerBackendConformance(
		"stateless-stub",
		RunnerBackend.toLayer(
			Effect.succeed({
				provisionRunner: ({ slotId }) =>
					Effect.succeed({
						externalRunnerId: ExternalRunnerId.make(`stub-${slotId}`),
					}),
				releaseRunner: () => Effect.succeed({ released: true }),
			}),
		),
	);

	runRunnerBackendConformance(
		"stateful-pool-tracker",
		RunnerBackend.toLayer(
			Effect.sync(() => {
				const active = new Map<string, ExternalRunnerId>();
				return {
					provisionRunner: ({ tier, slotId }) =>
						Effect.sync(() => {
							const id = ExternalRunnerId.make(`${tier}:${slotId}`);
							active.set(slotId, id);
							return { externalRunnerId: id };
						}),
					releaseRunner: ({ slotId }) =>
						Effect.sync(() => {
							const existed = active.delete(slotId);
							return { released: existed };
						}),
				};
			}),
		),
	);

	it("fails closed with ExternalSystemSchemaError when an adapter returns schema-drifting data", async () => {
		const DriftedBackend = RunnerBackend.toLayer(
			Effect.succeed({
				provisionRunner: () =>
					Effect.sync(() => JSON.parse('{"externalRunnerId":""}')),
				releaseRunner: () => Effect.succeed({ released: true }),
			}),
		);

		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const backend = yield* RunnerBackend;
				return yield* backend.provisionRunner({
					stationId: station.id,
					jobId: JobDispatchId.make("job-drift"),
					poolId: LOCAL_POOL.poolId,
					tier: "local",
					runnerLabel: LOCAL_POOL.runnerLabel,
					slotId: SlotId.make("slot-drift"),
				});
			}).pipe(Effect.provide(DriftedBackend)),
		);

		expect(Exit.isFailure(exit)).toBe(true);
	});
});
