import type {
	AppendOptions,
	EventEnvelope,
	EventInput,
	EventStore,
	StreamFilter,
	Subscription,
} from "@hobo/core";

// The naked emit/subscribe surface over the event log (data-plane.md: domain
// facts that need no aggregate invariant boundary still ride the same log, and
// subscribers observe them live). Aggregate-guarded writes go through
// @hobo/data's `defineAggregate`; this is the choreography/fan-out path.

export interface EmitResult {
	streamId: string;
	// The seq of the last appended fact — the reads-your-writes watermark.
	seq: number;
	appended: EventEnvelope[];
}

export async function emit(
	store: EventStore,
	streamId: string,
	events: EventInput[],
	options: AppendOptions,
): Promise<EmitResult> {
	const result = await store.append(streamId, events, options);
	const last = result.appended[result.appended.length - 1];
	return {
		streamId: result.streamId,
		seq: last ? last.seq : options.expectedSeq,
		appended: result.appended,
	};
}

export function subscribe(
	store: EventStore,
	filter: StreamFilter,
	handler: (event: EventEnvelope) => void | Promise<void>,
): Subscription {
	return store.subscribe(filter, handler);
}
