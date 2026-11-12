// SSE `/v1/cd/stream` (WP12): every fact @hobo/cd appends — Freight,
// pipelines, promotions, reconcile status, inventory, placement, fan-out,
// failover, policy and compliance — tailed from the journal by position.
//
// Each frame is `id: <position>` / `event: <event type>` / `data: <JSON>`.
// A client resumes with `Last-Event-ID` (or `?after=` where headers cannot be
// set): frames start strictly after that position, so nothing is skipped or
// repeated. Heartbeat comments keep proxies open; the response ends with
// `event: end` at the long-poll bound (55 s by default) and EventSource
// reconnects with the last id. A journal failure ends with `event: error`.
import type { DurableEventStore, EventPosition, PositionedEvent } from "@hobo/core";
import { CD_DEFAULTS } from "../events.js";
import { messageOf, serviceReason } from "./errors.js";
import { encode, stringify } from "./wire.js";

/** Every @hobo/cd stream id starts with this prefix (CD_STREAMS). */
export const CD_STREAM_PREFIX = "cd-";

export type StreamOptions = Readonly<{
	store: Pick<DurableEventStore, "readAll">;
	tenant: string;
	after?: EventPosition;
	types?: ReadonlySet<string>;
	signal: AbortSignal;
	pollMs: number;
	heartbeatMs: number;
	maxMs: number;
	batch: number;
	onFrames?: (count: number) => void;
}>;

export function frameOf(e: PositionedEvent): string {
	const position = e.position.toString();
	const data = { position, streamId: e.event.streamId, type: e.event.type, ts: e.event.ts, data: e.event.data };
	return `id: ${position}\nevent: ${e.event.type}\ndata: ${stringify(data)}\n\n`;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}

export async function* cdEventStream(o: StreamOptions): AsyncIterable<Uint8Array> {
	let cursor = o.after;
	const startedAt = Date.now();
	let lastBeat = startedAt;
	yield encode(`retry: ${CD_DEFAULTS.serviceTickMs}\n: hobo cd stream\n\n`);
	try {
		while (!o.signal.aborted) {
			let sent = 0;
			let read = 0;
			for await (const e of o.store.readAll({ ...(cursor === undefined ? {} : { after: cursor }), limit: o.batch, tenant: o.tenant })) {
				read += 1;
				cursor = e.position;
				if (!e.event.streamId.startsWith(CD_STREAM_PREFIX)) continue;
				if (o.types && !o.types.has(e.event.type)) continue;
				sent += 1;
				yield encode(frameOf(e));
				if (o.signal.aborted) return;
			}
			if (sent > 0) o.onFrames?.(sent);
			if (read >= o.batch) continue;
			const now = Date.now();
			if (now - startedAt >= o.maxMs) break;
			if (now - lastBeat >= o.heartbeatMs) {
				lastBeat = now;
				yield encode(": heartbeat\n\n");
			}
			await wait(Math.min(o.pollMs, Math.max(1, o.maxMs - (now - startedAt))), o.signal);
		}
		if (o.signal.aborted) return;
		yield encode(`event: end\ndata: ${stringify({ reason: "long-poll", lastEventId: cursor?.toString() ?? null })}\n\n`);
	} catch (error) {
		// The journal is the only thing this generator reads, so any failure is a store failure.
		const reason = serviceReason("store-unavailable", messageOf(error), "stream");
		yield encode(
			`event: error\ndata: ${stringify({ code: reason.code, message: reason.message, remediation: reason.remediation, lastEventId: cursor?.toString() ?? null })}\n\n`,
		);
	}
}

export const STREAM_DEFAULTS = Object.freeze({
	pollMs: CD_DEFAULTS.serviceTickMs,
	heartbeatMs: CD_DEFAULTS.feedHeartbeatMs,
	maxMs: CD_DEFAULTS.feedLongPollMs,
	batch: 256,
});
