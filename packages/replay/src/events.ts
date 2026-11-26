/**
 * Session Replay lifecycle events (`replay.*` family).
 * Distinct from auth `session.*` and from control-plane event-log "replay".
 */
// public-contract: replay event schema version.
export const REPLAY_EVENT_SCHEMA = "hobo.replay-events/v1" as const;

export const REPLAY_EVENTS = Object.freeze({
	Started: "replay.Started",
	ChunkIngested: "replay.ChunkIngested",
	Ended: "replay.Ended",
	ErrorLinked: "replay.ErrorLinked",
	RetentionApplied: "replay.RetentionApplied",
	Accessed: "replay.Accessed",
	Disabled: "replay.Disabled",
	Metered: "replay.Metered",
} as const);

export type ReplayEventType =
	(typeof REPLAY_EVENTS)[keyof typeof REPLAY_EVENTS];

export type ReplayEvent = Readonly<{
	id: string;
	type: ReplayEventType;
	schemaVersion: typeof REPLAY_EVENT_SCHEMA;
	sessionId: string;
	stationId: string;
	seq: number;
	time: string;
	correlationId: string;
	causationId: string;
	/** Heavy rrweb blobs are content-addressed refs — never full streams here. */
	data: Readonly<Record<string, unknown>>;
}>;

export function createReplayEvent(
	type: ReplayEventType,
	input: {
		readonly sessionId: string;
		readonly stationId: string;
		readonly seq: number;
		readonly time?: string;
		readonly causationId?: string;
		readonly data?: Readonly<Record<string, unknown>>;
	},
): ReplayEvent {
	const data = input.data ?? {};
	const blob = JSON.stringify(data);
	// Redaction-at-capture for control-plane metadata events.
	if (
		/(password|api[_-]?key|private[_-]?key|BEGIN (RSA |EC )?PRIVATE KEY)/i.test(
			blob,
		)
	) {
		throw Object.assign(
			new Error("replay event must not contain plaintext secrets"),
			{ code: "replay-event-secret-forbidden" },
		);
	}
	// Refuse embedding full rrweb streams in the control-plane event log.
	if (
		Array.isArray((data as { events?: unknown }).events) &&
		((data as { events: unknown[] }).events?.length ?? 0) > 0
	) {
		throw Object.assign(
			new Error(
				"replay events must reference blob_ref only; never embed rrweb streams",
			),
			{ code: "replay-event-blob-forbidden" },
		);
	}
	return Object.freeze({
		id: `evt-${type}-${input.sessionId}-${input.seq}`,
		type,
		schemaVersion: REPLAY_EVENT_SCHEMA,
		sessionId: input.sessionId,
		stationId: input.stationId,
		seq: input.seq,
		time: input.time ?? new Date().toISOString(),
		correlationId: `corr-replay-${input.sessionId}`,
		causationId: input.causationId ?? `cause-replay-${input.sessionId}`,
		data: Object.freeze({ ...data }),
	});
}
