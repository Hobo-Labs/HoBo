import type { EventEnvelope, EventStore } from "@hobo/core";

// Store seam (control-plane.md "Event Store + Projections": source of truth).
// The Yard kernel persists to the core EventStore port; in tests that port is
// backed by runtime-local's sqlite engine (Decision D6). Append-only, per-stream
// seq — the kernel adds no persistence of its own, it composes the port.

export type { EventEnvelope, EventStore } from "@hobo/core";

// Drain a stream to an array (read-model rebuild / snapshot helpers).
export async function collectStream(
	store: Pick<EventStore, "read">,
	streamId: string,
	fromSeq?: number,
): Promise<EventEnvelope[]> {
	const events: EventEnvelope[] = [];
	for await (const event of store.read(streamId, fromSeq)) events.push(event);
	return events;
}

// Fencing token for a choreography write to a possibly-fenced stream. The
// deployment stream becomes fenced (owner_epoch > 0) once an aggregate or
// leased actor writes to it; subsequent choreography fan-out by the SAME
// logical writer must carry the current owner epoch rather than bypass or
// rotate the fence (same rule as runtime-local's quarantine path). Returns
// undefined for unfenced streams or stores without fencing metadata.
export function currentFenceToken(
	store: Pick<EventStore, "getStreamHead">,
	streamId: string,
): bigint | undefined {
	const head = store.getStreamHead?.(streamId);
	return head !== undefined && head.ownerEpoch > 0n
		? head.ownerEpoch
		: undefined;
}
