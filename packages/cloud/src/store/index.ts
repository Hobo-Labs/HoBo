import type { EventEnvelope, EventStore } from "@hobo/core";

export type { EventEnvelope, EventStore } from "@hobo/core";

export async function collectStream(
	store: Pick<EventStore, "read">,
	streamId: string,
	fromSeq?: number,
): Promise<EventEnvelope[]> {
	const events: EventEnvelope[] = [];
	for await (const event of store.read(streamId, fromSeq)) events.push(event);
	return events;
}

export function currentFenceToken(
	store: Pick<EventStore, "getStreamHead">,
	streamId: string,
): bigint | undefined {
	const head = store.getStreamHead?.(streamId);
	return head !== undefined && head.ownerEpoch > 0n
		? head.ownerEpoch
		: undefined;
}
