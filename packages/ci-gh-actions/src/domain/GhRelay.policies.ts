import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { AnswerGhRelayJob } from "./AnswerGhRelayJob.saga.js";
import { GhRelayJob, GhRelayJobQueued } from "./GhRelayJob.aggregate.js";

export class GhRelayJobQueuedPolicy extends Domain.Policy(
	"GhRelayJobQueuedPolicy",
	{
		from: GhRelayJob,
		on: [GhRelayJobQueued],
	},
	{
		description:
			"Trigger AnswerGhRelayJob saga whenever a GitHub Actions relay or check job is queued.",
	},
) {}

export const GhRelayJobQueuedPolicyLive = GhRelayJobQueuedPolicy.toLayer(
	Effect.gen(function* () {
		const saga = yield* AnswerGhRelayJob;
		return ({ source, event }) =>
			saga.start(source, {
				context: event.context,
			});
	}),
);
