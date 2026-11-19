import type {
	AppendOptions,
	EventEnvelope,
	EventInput,
	EventStore,
	StreamFilter,
	Subscription,
} from "@hobo/core";

export interface EmitResult {
	streamId: string;
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
