import type { EventEnvelope } from "./types.js";

/** Capture and reject facts returned from a different run's stream. */
export function captureJournalStream(
	events: readonly EventEnvelope[],
	streamId: string,
): EventEnvelope[] {
	const captured = events.map((event) => structuredClone(event));
	for (const event of captured) {
		if (event.streamId !== streamId)
			throw new Error("workflow journal contains a foreign stream");
	}
	return captured;
}
