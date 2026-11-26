import {
	createReplayEvent,
	REPLAY_EVENTS,
	type ReplayEvent,
} from "./events.js";
import { redactDebugPayload } from "./privacy.js";
import type { SessionBlobStore, SessionIndex } from "./storage.js";
import {
	defaultPrivacyPolicy,
	REPLAY_SCHEMA_VERSION,
	type RecordingChunk,
	type RrwebEvent,
	type SessionCorrelation,
	type SessionRecord,
} from "./types.js";

// public-contract: synchronized debug event wire discriminator.
export const DEBUG_REPLAY_SCHEMA_VERSION = "hobo.debug-replay/v1" as const;
export const DEBUG_REPLAY_EVENT_TYPE = -1 as const;
// public-contract: process-level debug replay detail override.
export const DEBUG_REPLAY_LEVEL_ENV = "HOBO_REPLAY_LEVEL" as const;

export const DEBUG_REPLAY_TRACKS = Object.freeze([
	"browser",
	"terminal",
	"agent",
	"git",
	"test",
	"annotation",
	"approval",
] as const);

export type DebugReplayTrack = (typeof DEBUG_REPLAY_TRACKS)[number];
export type DebugReplayLevel = "off" | "metadata" | "observable" | "diagnostic";

export type DebugTrackEnvelope = RrwebEvent &
	Readonly<{
		type: typeof DEBUG_REPLAY_EVENT_TYPE;
		data: Readonly<{
			schemaVersion: typeof DEBUG_REPLAY_SCHEMA_VERSION;
			track: DebugReplayTrack;
			sequence: number;
			level: Exclude<DebugReplayLevel, "off">;
			payload: Readonly<{
				metadata: Readonly<Record<string, unknown>>;
				observable?: Readonly<Record<string, unknown>>;
				diagnostic?: Readonly<Record<string, unknown>>;
			}>;
		}>;
	}>;

export type DebugTrackInput = Readonly<{
	track: DebugReplayTrack;
	sequence: number;
	timestamp: number;
	level?: DebugReplayLevel;
	metadata?: Readonly<Record<string, unknown>>;
	observable?: Readonly<Record<string, unknown>>;
	diagnostic?: Readonly<Record<string, unknown>>;
}>;

export type DebugReplayRecordInput = Omit<
	DebugTrackInput,
	"level" | "sequence" | "timestamp"
> &
	Readonly<{ timestamp?: number }>;

export type DebugReplayRecording = Readonly<{
	session: SessionRecord;
	chunks: readonly RecordingChunk[];
}>;

export type DebugReplayRecorder = Readonly<{
	sessionId: string;
	level: DebugReplayLevel;
	enabled: boolean;
	record: (input: DebugReplayRecordInput) => boolean;
	flush: () => Promise<void>;
	stop: () => Promise<DebugReplayRecording | undefined>;
	bufferedCount: () => number;
}>;

export function resolveDebugReplayLevel(input?: {
	readonly level?: DebugReplayLevel;
	readonly env?: Readonly<Record<string, string | undefined>>;
}): DebugReplayLevel {
	const env = input?.env ?? {};
	if (["0", "false", "off"].includes(env.HOBO_REPLAY?.toLowerCase() ?? "")) {
		return "off";
	}
	const level = input?.level ?? env[DEBUG_REPLAY_LEVEL_ENV] ?? "observable";
	if (!["off", "metadata", "observable", "diagnostic"].includes(level)) {
		throw Object.assign(new Error(`invalid debug replay level: ${level}`), {
			code: "replay-level-invalid",
		});
	}
	return level as DebugReplayLevel;
}

export function createDebugTrackEnvelope(
	input: DebugTrackInput,
): DebugTrackEnvelope | undefined {
	const level = resolveDebugReplayLevel(
		input.level === undefined ? undefined : { level: input.level },
	);
	if (level === "off") return undefined;

	const payload = redactDebugPayload({
		metadata: input.metadata ?? {},
		...(level !== "metadata" && input.observable !== undefined
			? { observable: input.observable }
			: {}),
		...(level === "diagnostic" && input.diagnostic !== undefined
			? { diagnostic: input.diagnostic }
			: {}),
	});
	return Object.freeze({
		type: DEBUG_REPLAY_EVENT_TYPE,
		timestamp: input.timestamp,
		data: Object.freeze({
			schemaVersion: DEBUG_REPLAY_SCHEMA_VERSION,
			track: input.track,
			sequence: input.sequence,
			level,
			payload: payload as DebugTrackEnvelope["data"]["payload"],
		}),
	});
}

export function isDebugTrackEnvelope(
	event: RrwebEvent,
): event is DebugTrackEnvelope {
	return (
		event.type === DEBUG_REPLAY_EVENT_TYPE &&
		event.data.schemaVersion === DEBUG_REPLAY_SCHEMA_VERSION &&
		DEBUG_REPLAY_TRACKS.includes(event.data.track as DebugReplayTrack) &&
		Number.isSafeInteger(event.data.sequence)
	);
}

/** Persist synchronized agent-debug tracks through the existing replay ports. */
export function createDebugReplayRecorder(input: {
	readonly correlation: SessionCorrelation;
	readonly store: SessionBlobStore;
	readonly index: SessionIndex;
	readonly sessionId?: string;
	readonly level?: DebugReplayLevel;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly batchSize?: number;
	readonly now?: () => string;
	readonly onEvent?: (event: ReplayEvent) => void;
}): DebugReplayRecorder {
	const level = resolveDebugReplayLevel({
		...(input.level === undefined ? {} : { level: input.level }),
		...(input.env === undefined ? {} : { env: input.env }),
	});
	const now = input.now ?? (() => new Date().toISOString());
	const sessionId =
		input.sessionId ??
		`debug-${input.correlation.stationId.replace(/[^a-z0-9]+/gi, "-")}-${Date.now().toString(36)}`;
	const batchSize = Math.max(1, Math.floor(input.batchSize ?? 50));
	const privacy = defaultPrivacyPolicy();
	const startedAt = now();
	let eventSequence = 0;
	let itemSequence = 0;
	let chunkSequence = 0;
	let initialized = false;
	let writing = false;
	let existing: SessionRecord | undefined;
	let stopped = false;
	let failure: unknown;
	let stopResult: Promise<DebugReplayRecording | undefined> | undefined;
	const buffer: DebugReplayRecordInput[] = [];
	const chunks: RecordingChunk[] = [];

	const emit = (type: ReplayEvent["type"], data: Record<string, unknown>) => {
		input.onEvent?.(
			createReplayEvent(type, {
				sessionId,
				stationId: input.correlation.stationId,
				seq: eventSequence++,
				time: now(),
				data,
			}),
		);
	};

	if (level === "off") {
		emit(REPLAY_EVENTS.Disabled, { mode: "debug", reason: "level-off" });
		return Object.freeze({
			sessionId,
			level,
			enabled: false,
			record: () => false,
			bufferedCount: () => 0,
			async flush() {},
			async stop() {
				return undefined;
			},
		});
	}

	const initialize = async () => {
		if (initialized) return;
		existing = await input.index.get(sessionId);
		chunks.push(...(await input.index.listChunks(sessionId)));
		chunkSequence = chunks.reduce(
			(max, chunk) => Math.max(max, chunk.seq + 1),
			0,
		);
		for (const chunk of chunks) {
			for (const event of (await input.store.get(chunk.blobRef)) ?? []) {
				if (isDebugTrackEnvelope(event)) {
					itemSequence = Math.max(itemSequence, event.data.sequence + 1);
				}
			}
		}
		initialized = true;
	};

	const beginWriting = async () => {
		if (writing) return;
		await initialize();
		let session: SessionRecord;
		if (existing) {
			const { endedAt: _endedAt, ...resumable } = existing;
			session = Object.freeze({ ...resumable, status: "recording" });
		} else {
			session = Object.freeze({
				schemaVersion: REPLAY_SCHEMA_VERSION,
				id: sessionId,
				status: "recording",
				startedAt,
				correlation: input.correlation,
				privacy,
				chunkCount: 0,
				totalBytes: 0,
			});
		}
		await input.index.upsert(session);
		existing = session;
		writing = true;
		emit(REPLAY_EVENTS.Started, { mode: "debug", level });
	};

	let writes: Promise<void> = Promise.resolve();

	const queueBuffered = () => {
		if (buffer.length === 0) return;
		const pending = Object.freeze(buffer.splice(0, buffer.length));
		writes = writes
			.then(async () => {
				await beginWriting();
				const batch = Object.freeze(
					pending.flatMap((entry) => {
						const envelope = createDebugTrackEnvelope({
							...entry,
							sequence: itemSequence++,
							timestamp: entry.timestamp ?? Date.now(),
							level,
						});
						return envelope ? [envelope] : [];
					}),
				);
				if (batch.length === 0) return;
				const seq = chunkSequence++;
				const chunk = await input.store.put(sessionId, seq, batch);
				await input.index.appendChunkMeta(sessionId, chunk);
				chunks.push(chunk);
				emit(REPLAY_EVENTS.ChunkIngested, {
					mode: "debug",
					level,
					blobRef: chunk.blobRef,
					bytes: chunk.byteSize,
					chunkSeq: chunk.seq,
				});
			})
			.catch((error: unknown) => {
				failure ??= error;
			});
	};

	const flush = async () => {
		queueBuffered();
		await writes;
		if (failure !== undefined) throw failure;
	};

	return Object.freeze({
		sessionId,
		level,
		enabled: true,
		bufferedCount: () => buffer.length,
		record(entry) {
			if (stopped) return false;
			buffer.push(entry);
			if (buffer.length >= batchSize) queueBuffered();
			return true;
		},
		flush,
		async stop() {
			if (stopResult) return stopResult;
			stopped = true;
			stopResult = (async () => {
				await flush();
				await beginWriting();
				const current = await input.index.get(sessionId);
				if (!current) throw new Error(`replay session missing: ${sessionId}`);
				const session: SessionRecord = Object.freeze({
					...current,
					status: "ended",
					endedAt: now(),
				});
				await input.index.upsert(session);
				emit(REPLAY_EVENTS.Ended, {
					mode: "debug",
					level,
					chunkCount: session.chunkCount,
					totalBytes: session.totalBytes,
				});
				return Object.freeze({
					session,
					chunks: Object.freeze([...chunks]),
				});
			})();
			return stopResult;
		},
	});
}
