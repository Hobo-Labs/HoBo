import * as Domain from "@alchemy.run/domain";
import type { Handler, TriggerOf } from "@alchemy.run/domain/Policy";
import * as Effect from "effect/Effect";
import { DispatchJob } from "./DispatchJob.saga.js";
import { NonEmptyReason, NonNegativeMicros, PositiveSeconds } from "./ids.js";
import {
	ExpireJobDispatch,
	JobDispatch,
	JobDispatchCompleted,
	JobDispatchExpired,
	JobDispatchObserved,
} from "./JobDispatch.aggregate.js";
import { RunnerBackend } from "./RunnerBackend.external.js";
import { ReleaseBalancedSlot, StationFleet } from "./StationFleet.aggregate.js";

const ZERO_MICROS = NonNegativeMicros.make(0);
const UNBOUNDED_QUEUE_GUARD_SECONDS = PositiveSeconds.make(86_400);

export class JobObservedPolicy extends Domain.Policy(
	"JobObservedPolicy",
	{
		from: JobDispatch,
		on: [JobDispatchObserved],
	},
	{
		description:
			"Starts balanced dispatch saga and arms queue expiry whenever a CI job is observed.",
	},
) {}

export const JobObservedPolicyLive = JobObservedPolicy.toLayer(
	Effect.gen(function* () {
		const dispatches = yield* DispatchJob;
		const jobs = yield* JobDispatch;
		return Effect.fn(function* ({ source, event }) {
			yield* dispatches.start(source, {
				stationId: event.stationId,
				requirements: event.requirements,
			});
			const expirySeconds =
				event.deadlineSeconds ?? UNBOUNDED_QUEUE_GUARD_SECONDS;
			yield* jobs.schedule(
				source,
				new ExpireJobDispatch({
					reason: NonEmptyReason.make("queue-deadline-elapsed"),
				}),
				{ after: `${expirySeconds} seconds` },
			);
		});
	}),
);

export class JobCompletedPolicy extends Domain.Policy(
	"JobCompletedPolicy",
	{
		from: JobDispatch,
		on: [JobDispatchCompleted],
	},
	{
		description:
			"Releases runner capacity and settles actual spend on StationFleet when a bound job completes.",
	},
) {}

export const JobCompletedPolicyLive = JobCompletedPolicy.toLayer(
	Effect.gen(function* () {
		const fleet = yield* StationFleet;
		const backend = yield* RunnerBackend;
		// SAFETY: Policy.Handler is typed void-only; releaseRunner failures must surface before slot settlement.
		return Effect.fn(function* ({ event }) {
			yield* backend.releaseRunner({
				stationId: event.stationId,
				slotId: event.slotId,
			});
			yield* fleet.send(
				event.stationId,
				new ReleaseBalancedSlot({
					slotId: event.slotId,
					settledMicros: event.settledMicros,
				}),
			);
		}) as Handler<TriggerOf<typeof JobCompletedPolicy>>;
	}),
);

export class JobExpiredPolicy extends Domain.Policy(
	"JobExpiredPolicy",
	{
		from: JobDispatch,
		on: [JobDispatchExpired],
	},
	{
		description:
			"Releases runner capacity and slot reservation when a bound job hits its deadline.",
	},
) {}

export const JobExpiredPolicyLive = JobExpiredPolicy.toLayer(
	Effect.gen(function* () {
		const fleet = yield* StationFleet;
		const backend = yield* RunnerBackend;
		// SAFETY: Policy.Handler is typed void-only; releaseRunner failures must surface before slot settlement.
		return Effect.fn(function* ({ event }) {
			if (event.slotId === null || event.stationId === null) {
				return;
			}
			yield* backend.releaseRunner({
				stationId: event.stationId,
				slotId: event.slotId,
			});
			yield* fleet.send(
				event.stationId,
				new ReleaseBalancedSlot({
					slotId: event.slotId,
					settledMicros: ZERO_MICROS,
				}),
			);
		}) as Handler<TriggerOf<typeof JobExpiredPolicy>>;
	}),
);
