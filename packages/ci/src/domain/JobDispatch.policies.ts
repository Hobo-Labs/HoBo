import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { DispatchJob } from "./DispatchJob.saga.js";
import {
	ExpireJobDispatch,
	JobDispatch,
	JobDispatchCompleted,
	JobDispatchObserved,
} from "./JobDispatch.aggregate.js";
import { RunnerBackend } from "./RunnerBackend.external.js";
import { ReleaseBalancedSlot, StationFleet } from "./StationFleet.aggregate.js";

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
			if (event.deadlineSeconds !== null && event.deadlineSeconds > 0) {
				yield* jobs.schedule(
					source,
					new ExpireJobDispatch({ reason: "queue-deadline-elapsed" }),
					{ after: `${event.deadlineSeconds} seconds` },
				);
			}
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
		});
	}),
);
