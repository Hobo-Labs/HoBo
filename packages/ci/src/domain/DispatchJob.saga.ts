import * as Domain from "@alchemy.run/domain";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { Activity, Workflow } from "effect/workflow";
import {
	ExternalRunnerId,
	JobDispatchId,
	JobRequirements,
	NonEmptyReason,
	NonNegativeMicros,
	PositiveAttempts,
	RunnerPoolId,
	RunnerTier,
	RunsOnLabel,
	SlotId,
	StationId,
} from "./ids.js";
import {
	BindRunnerStart,
	FailJobDispatch,
	JobDispatch,
	JobNotQueued,
	StartBindingConflict,
} from "./JobDispatch.aggregate.js";
import {
	RunnerBackend,
	RunnerCapacityExhausted,
	RunnerProvisionFailed,
} from "./RunnerBackend.external.js";
import {
	BudgetCeilingExceeded,
	DuplicateJobReservation,
	NoEligibleRunnerPool,
	ReleaseBalancedSlot,
	ReserveBalancedSlot,
	StationFleet,
} from "./StationFleet.aggregate.js";

const MAX_DISPATCH_ATTEMPTS = 6;
const ZERO_MICROS = NonNegativeMicros.make(0);

const ReserveSuccess = Schema.Struct({
	slotId: SlotId,
	poolId: RunnerPoolId,
	tier: RunnerTier,
	runsOn: RunsOnLabel,
	reservedMicros: NonNegativeMicros,
});

const ProvisionSuccess = Schema.Struct({
	externalRunnerId: ExternalRunnerId,
});

const ReserveRejection = Schema.Union([
	NoEligibleRunnerPool,
	BudgetCeilingExceeded,
	DuplicateJobReservation,
]);

const ProvisionFailure = Schema.Union([
	RunnerCapacityExhausted,
	RunnerProvisionFailed,
]);

const BindRejection = Schema.Union([JobNotQueued, StartBindingConflict]);

const TaggedFailure = Schema.Struct({ _tag: Schema.NonEmptyString });
const decodeTaggedFailure = Schema.decodeUnknownOption(TaggedFailure);

function failureReason<E>(cause: Cause.Cause<E>): NonEmptyReason {
	const failure = Cause.findErrorOption(cause);
	if (failure._tag === "Some") {
		const decoded = decodeTaggedFailure(failure.value);
		if (decoded._tag === "Some") return NonEmptyReason.make(decoded.value._tag);
	}
	const pretty = Cause.pretty(cause).trim();
	return NonEmptyReason.make(pretty.length > 0 ? pretty : "dispatch-failed");
}

export class DispatchJob extends Domain.Saga(
	"DispatchJob",
	{
		key: JobDispatchId,
		input: {
			stationId: StationId,
			requirements: JobRequirements,
		},
		rejects: [
			NoEligibleRunnerPool,
			BudgetCeilingExceeded,
			DuplicateJobReservation,
			JobNotQueued,
			StartBindingConflict,
		],
	},
	{
		description:
			"Balance and provision a runner across local, Hostinger, Agent37, and GitHub-hosted pools with failover and compensation.",
	},
) {}

export const DispatchJobLive = DispatchJob.toLayer(
	Effect.gen(function* () {
		const fleet = yield* StationFleet;
		const jobs = yield* JobDispatch;
		const backend = yield* RunnerBackend;

		return Effect.fn(function* ({ key, stationId, requirements }) {
			yield* Workflow.addFinalizer((exit) =>
				Exit.isSuccess(exit)
					? Effect.void
					: Activity.make({
							name: "record-dispatch-failure",
							execute: jobs
								.send(
									key,
									new FailJobDispatch({
										reason: failureReason(exit.cause),
									}),
								)
								.pipe(Effect.asVoid),
						}).pipe(Effect.orDie),
			);

			const excludedPoolIds: RunnerPoolId[] = [];

			for (let attempt = 1; attempt <= MAX_DISPATCH_ATTEMPTS; attempt += 1) {
				const reservation = yield* Activity.make({
					name: `reserve-slot-${attempt}`,
					success: ReserveSuccess,
					error: ReserveRejection,
					execute: fleet
						.send(
							stationId,
							new ReserveBalancedSlot({
								jobId: key,
								requirements,
								excludedPoolIds: [...excludedPoolIds],
							}),
						)
						.pipe(Effect.map((receipt) => receipt.reply)),
				}).pipe(
					DispatchJob.withCompensation((reserved) =>
						Activity.make({
							name: `release-slot-compensation-${attempt}`,
							execute: fleet
								.send(
									stationId,
									new ReleaseBalancedSlot({
										slotId: reserved.slotId,
										settledMicros: ZERO_MICROS,
									}),
								)
								.pipe(Effect.asVoid),
						}),
					),
				);

				const { slotId, poolId, tier, runsOn } = reservation;

				const provisioned = yield* Activity.make({
					name: `provision-runner-${attempt}`,
					success: ProvisionSuccess,
					error: ProvisionFailure,
					execute: backend.provisionRunner({
						stationId,
						jobId: key,
						poolId,
						tier,
						runsOn,
						slotId,
					}),
				}).pipe(Effect.result);

				if (provisioned._tag === "Failure") {
					yield* Activity.make({
						name: `compensate-slot-${attempt}`,
						execute: fleet
							.send(
								stationId,
								new ReleaseBalancedSlot({
									slotId,
									settledMicros: ZERO_MICROS,
								}),
							)
							.pipe(Effect.asVoid),
					});
					excludedPoolIds.push(poolId);
					continue;
				}

				const boundVersion = yield* Activity.make({
					name: `bind-start-${attempt}`,
					success: Schema.Int,
					error: BindRejection,
					execute: jobs
						.send(
							key,
							new BindRunnerStart({
								poolId,
								tier,
								slotId,
								runsOn,
								externalRunnerId: provisioned.success.externalRunnerId,
								attempts: PositiveAttempts.make(attempt),
							}),
						)
						.pipe(Effect.map((receipt) => receipt.version)),
				});

				return boundVersion;
			}

			return yield* new NoEligibleRunnerPool({
				reasons: excludedPoolIds.map((poolId) =>
					NonEmptyReason.make(`${poolId}:provision-failed`),
				),
			});
		});
	}),
);
