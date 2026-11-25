/**
 * FinOps metering hooks for ingest volume, storage bytes, and player access.
 * Emits advisory `replay.Metered` facts (compose with MeteringView / ADR-0039).
 */
import { createReplayEvent, REPLAY_EVENTS } from "./events.js";

export type ReplayMeterKind =
	| "ingest-bytes"
	| "storage-bytes"
	| "player-access"
	| "export";

export type ReplayMeterEvent = Readonly<{
	kind: ReplayMeterKind;
	sessionId: string;
	stationId: string;
	tenant: string;
	bytes: number;
	at: string;
}>;

export type MeterSink = {
	record(event: ReplayMeterEvent): void;
};

export function createMemoryMeterSink(): MeterSink & {
	readonly events: readonly ReplayMeterEvent[];
} {
	const events: ReplayMeterEvent[] = [];
	return {
		get events() {
			return events;
		},
		record(event) {
			events.push(Object.freeze({ ...event }));
		},
	};
}

export function meterIngest(
	sink: MeterSink,
	input: {
		readonly sessionId: string;
		readonly stationId: string;
		readonly tenant: string;
		readonly bytes: number;
		readonly at?: string;
	},
): ReturnType<typeof createReplayEvent> {
	const at = input.at ?? new Date().toISOString();
	sink.record({
		kind: "ingest-bytes",
		sessionId: input.sessionId,
		stationId: input.stationId,
		tenant: input.tenant,
		bytes: input.bytes,
		at,
	});
	return createReplayEvent(REPLAY_EVENTS.Metered, {
		sessionId: input.sessionId,
		stationId: input.stationId,
		seq: Date.now() % 1_000_000,
		time: at,
		data: {
			kind: "ingest-bytes",
			bytes: input.bytes,
			tenant: input.tenant,
		},
	});
}

export function meterPlayerAccess(
	sink: MeterSink,
	input: {
		readonly sessionId: string;
		readonly stationId: string;
		readonly tenant: string;
		readonly at?: string;
	},
): ReturnType<typeof createReplayEvent> {
	const at = input.at ?? new Date().toISOString();
	sink.record({
		kind: "player-access",
		sessionId: input.sessionId,
		stationId: input.stationId,
		tenant: input.tenant,
		bytes: 0,
		at,
	});
	return createReplayEvent(REPLAY_EVENTS.Metered, {
		sessionId: input.sessionId,
		stationId: input.stationId,
		seq: Date.now() % 1_000_000,
		time: at,
		data: {
			kind: "player-access",
			bytes: 0,
			tenant: input.tenant,
		},
	});
}
