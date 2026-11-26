/**
 * Browser-safe Session Replay tracker factory.
 * Built on injectable rrweb record engine (default: fixture/noop for Node;
 * wire `rrweb.record` in browser / templates).
 *
 * Performance budget (documented ADR-0137):
 * - Idle batching default 1s / 50 events
 * - Main-thread work per batch target < 16ms on representative page
 * - Gzip/deflate optional; never block paint
 * - Tracker surface code kept < ~15KB gzipped beyond rrweb core
 */
import { createReplayEvent, REPLAY_EVENTS } from "./events.js";
import {
	evaluateRecordingPolicy,
	type RecordingDecision,
	type RecordingPolicyInput,
} from "./policy.js";
import { assertNoSensitivePlaintext, maskRrwebEvents } from "./privacy.js";
import type { SessionBlobStore, SessionIndex } from "./storage.js";
import {
	defaultPrivacyPolicy,
	type PrivacyPolicy,
	REPLAY_SCHEMA_VERSION,
	type RrwebEvent,
	type SessionCorrelation,
	type SessionRecord,
} from "./types.js";

export type RecordEngine = {
	/** Start recording; return stop handle. Emits events via onEmit. */
	start(options: {
		onEmit: (event: RrwebEvent) => void;
		privacy: PrivacyPolicy;
	}): () => void;
};

/** Deterministic fixture engine for dual-fixture / CI paths (no live DOM). */
export function createFixtureRecordEngine(
	seedEvents: readonly RrwebEvent[] = [],
): RecordEngine {
	return {
		start({ onEmit }) {
			for (const e of seedEvents) {
				onEmit(e);
			}
			return () => {};
		},
	};
}

/**
 * Thin adapter shape for rrweb.record (browser). Callers inject:
 * `createRrwebRecordEngine(rrweb.record)`.
 */
export function createRrwebRecordEngine(
	recordFn: (opts: {
		emit: (event: RrwebEvent) => void;
		maskInputOptions?: Readonly<Record<string, boolean>>;
		maskTextSelector?: string;
		blockSelector?: string;
	}) => () => void,
): RecordEngine {
	return {
		start({ onEmit, privacy }) {
			return recordFn({
				emit: onEmit,
				maskInputOptions: {
					password: privacy.maskPasswords,
					email: privacy.maskEmails,
					tel: privacy.maskTel,
				},
				maskTextSelector: privacy.maskSelectors
					.filter((s) => s.startsWith(".") || s.startsWith("["))
					.join(","),
				blockSelector: privacy.maskSelectors.join(","),
			});
		},
	};
}

export type TrackerOptions = Readonly<{
	correlation: SessionCorrelation;
	store: SessionBlobStore;
	index: SessionIndex;
	engine?: RecordEngine;
	policy?: RecordingPolicyInput;
	batchSize?: number;
	/** Flush interval ms (async batching). */
	flushIntervalMs?: number;
	sessionId?: string;
	now?: () => string;
	onEvent?: (event: ReturnType<typeof createReplayEvent>) => void;
}>;

export type TrackerHandle = Readonly<{
	sessionId: string;
	decision: RecordingDecision;
	/** Stop capture, flush remaining, emit replay.Ended. */
	stop: () => Promise<SessionRecord | undefined>;
	/** Force flush of buffered events. */
	flush: () => Promise<void>;
	/** Link an error id mid-session. */
	linkError: (errorId: string, controlPlaneEventId?: string) => Promise<void>;
	/** Record Harness flag exposure. */
	noteFlagExposure: (flagKey: string) => void;
	/** Buffered event count (test/diagnostics). */
	bufferedCount: () => number;
	/** Whether kill switch / policy disabled capture. */
	enabled: boolean;
}>;

export function createTracker(options: TrackerOptions): TrackerHandle {
	const decision = evaluateRecordingPolicy(options.policy ?? {});
	const privacy = decision.privacy;
	const sessionId =
		options.sessionId ??
		`sess-${options.correlation.stationId.replace(/[^a-z0-9]+/gi, "-")}-${Date.now().toString(36)}`;
	const now = options.now ?? (() => new Date().toISOString());
	let seq = 0;
	let eventSeq = 0;
	const buffer: RrwebEvent[] = [];
	let stopped = false;
	let correlation = options.correlation;
	let stopEngine: (() => void) | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	const batchSize = options.batchSize ?? 50;
	const flushIntervalMs = options.flushIntervalMs ?? 1000;

	const emitMeta = (
		type: (typeof REPLAY_EVENTS)[keyof typeof REPLAY_EVENTS],
		data: Record<string, unknown> = {},
	) => {
		const evt = createReplayEvent(type, {
			sessionId,
			stationId: correlation.stationId,
			seq: eventSeq++,
			time: now(),
			data,
		});
		options.onEvent?.(evt);
		return evt;
	};

	const persistSession = async (
		status: SessionRecord["status"],
		extra?: Partial<SessionRecord>,
	) => {
		const record: SessionRecord = Object.freeze({
			schemaVersion: REPLAY_SCHEMA_VERSION,
			id: sessionId,
			status,
			startedAt: extra?.startedAt ?? now(),
			...(extra?.endedAt !== undefined ? { endedAt: extra.endedAt } : {}),
			correlation,
			privacy,
			chunkCount: extra?.chunkCount ?? 0,
			totalBytes: extra?.totalBytes ?? 0,
			...(extra?.summary !== undefined ? { summary: extra.summary } : {}),
		});
		await options.index.upsert(record);
		return record;
	};

	const flush = async () => {
		if (!decision.enabled || buffer.length === 0) {
			buffer.length = 0;
			return;
		}
		const batch = maskRrwebEvents(buffer.splice(0, buffer.length), privacy);
		const serialized = JSON.stringify(batch);
		assertNoSensitivePlaintext(serialized);
		const chunk = await options.store.put(sessionId, seq++, batch);
		await options.index.appendChunkMeta(sessionId, chunk);
		emitMeta(REPLAY_EVENTS.ChunkIngested, {
			blobRef: chunk.blobRef,
			bytes: chunk.byteSize,
			chunkSeq: chunk.seq,
		});
	};

	if (!decision.enabled) {
		emitMeta(REPLAY_EVENTS.Disabled, { reason: decision.reason });
		return Object.freeze({
			sessionId,
			decision,
			enabled: false,
			bufferedCount: () => 0,
			async stop() {
				return undefined;
			},
			async flush() {},
			async linkError() {},
			noteFlagExposure() {},
		});
	}

	const startedAt = now();
	// Synchronous lifecycle start so dual-fixture proofs stay deterministic.
	emitMeta(REPLAY_EVENTS.Started, {
		isolationClass: correlation.isolationClass,
		tenant: correlation.tenant,
	});
	void persistSession("recording", { startedAt });

	const engine = options.engine ?? createFixtureRecordEngine();
	stopEngine = engine.start({
		privacy,
		onEmit: (event) => {
			if (stopped || !decision.enabled) return;
			buffer.push(event);
			if (buffer.length >= batchSize) {
				void flush();
			}
		},
	});

	if (typeof setInterval === "function") {
		timer = setInterval(() => {
			void flush();
		}, flushIntervalMs);
		// Don't keep process alive solely for flush timer in Node tests.
		if (typeof timer === "object" && "unref" in timer) {
			(timer as { unref: () => void }).unref();
		}
	}

	return Object.freeze({
		sessionId,
		decision,
		enabled: true,
		bufferedCount: () => buffer.length,
		flush,
		noteFlagExposure(flagKey: string) {
			if (!correlation.harnessFlagKeys.includes(flagKey)) {
				correlation = Object.freeze({
					...correlation,
					harnessFlagKeys: Object.freeze([
						...correlation.harnessFlagKeys,
						flagKey,
					]),
				});
			}
		},
		async linkError(errorId: string, controlPlaneEventId?: string) {
			correlation = Object.freeze({
				...correlation,
				errorId,
				...(controlPlaneEventId !== undefined ? { controlPlaneEventId } : {}),
			});
			const cur = await options.index.get(sessionId);
			if (cur) {
				await options.index.upsert(Object.freeze({ ...cur, correlation }));
			}
			emitMeta(REPLAY_EVENTS.ErrorLinked, {
				errorId,
				...(controlPlaneEventId !== undefined ? { controlPlaneEventId } : {}),
			});
		},
		async stop() {
			if (stopped) {
				return options.index.get(sessionId);
			}
			stopped = true;
			stopEngine?.();
			if (timer) clearInterval(timer);
			await flush();
			const cur = await options.index.get(sessionId);
			const ended: SessionRecord = Object.freeze({
				schemaVersion: REPLAY_SCHEMA_VERSION,
				id: sessionId,
				status: "ended" as const,
				startedAt: cur?.startedAt ?? now(),
				endedAt: now(),
				correlation,
				privacy,
				chunkCount: cur?.chunkCount ?? 0,
				totalBytes: cur?.totalBytes ?? 0,
				...(cur?.summary !== undefined ? { summary: cur.summary } : {}),
			});
			await options.index.upsert(ended);
			emitMeta(REPLAY_EVENTS.Ended, {
				chunkCount: ended.chunkCount,
				totalBytes: ended.totalBytes,
			});
			return ended;
		},
	});
}

/** Template auto-wire helper: default local path with zero Bindle config. */
export function createDefaultLocalTracker(input: {
	readonly stationId?: string;
	readonly store: SessionBlobStore;
	readonly index: SessionIndex;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly engine?: RecordEngine;
	readonly seedEvents?: readonly RrwebEvent[];
}): TrackerHandle {
	const stationId = input.stationId ?? "station:local";
	return createTracker({
		correlation: {
			schemaVersion: "hobo.replay-correlation/v1",
			stationId,
			harnessFlagKeys: Object.freeze([]),
			isolationClass: "local-dev",
			tenant: "local",
			env: "local-dev",
		},
		store: input.store,
		index: input.index,
		engine:
			input.engine ??
			createFixtureRecordEngine(input.seedEvents ?? defaultDemoEvents()),
		policy: {
			...(input.env !== undefined ? { env: input.env } : {}),
			isolationClass: "local-dev",
			privacy: defaultPrivacyPolicy(),
		},
	});
}

function defaultDemoEvents(): readonly RrwebEvent[] {
	const t = Date.now();
	return Object.freeze([
		Object.freeze({
			type: 2,
			timestamp: t,
			data: Object.freeze({
				tagName: "html",
				attributes: Object.freeze({}),
				childNodes: Object.freeze([]),
			}),
		}),
		Object.freeze({
			type: 3,
			timestamp: t + 10,
			data: Object.freeze({
				source: 5,
				text: "hello",
				tagName: "div",
			}),
		}),
	]);
}
