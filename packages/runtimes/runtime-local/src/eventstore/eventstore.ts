import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
	AppendOptions,
	AppendResult,
	ClaimSubscriptionOptions,
	Clock,
	DurableCommitRequest,
	DurableCommitResult,
	DurableEventStore,
	EventEnvelope,
	EventInput,
	EventStore,
	FoldHandlers,
	FoldResult,
	PositionedEvent,
	ReadAllOptions,
	SnapshotRecord,
	StreamFilter,
	SubscriptionCheckpoint,
	SubscriptionLease,
} from "@hobo/core";
import {
	OptimisticSequenceConflictError,
	parseEventEnvelope,
	SnapshotAheadError,
} from "@hobo/core";
import { createNodeSqliteDriver, SqliteJournal } from "@hobo/storage-sqlite";
import {
	isJsonObject,
	type JsonObject,
	type JsonValue,
	parseJsonValue,
} from "../json.js";

import {
	type ParsedAppendContext,
	type ParsedEventInput,
	parseAppendContext,
	parseEventInput,
	parseEventInputs,
	parseExpectedSeq,
	parseStreamId,
} from "./parse.js";
import { defaultDbPath } from "./sqlite-store.js";
import { createUlidGenerator } from "./ulid.js";

export { OptimisticSequenceConflictError } from "@hobo/core";

export interface ManualClock extends Clock {
	advance(deltaMs: number): string;
}

export function createManualClock(
	startInstant = "2026-06-26T00:00:00.000Z",
): ManualClock {
	let nowMs = Date.parse(startInstant);
	if (Number.isNaN(nowMs)) {
		throw new TypeError("startInstant must be a valid ISO-8601 string");
	}

	return Object.freeze({
		now() {
			return new Date(nowMs).toISOString();
		},
		advance(deltaMs: number) {
			if (!Number.isSafeInteger(deltaMs) || deltaMs < 0) {
				throw new TypeError("deltaMs must be a non-negative safe integer");
			}
			nowMs += deltaMs;
			return this.now();
		},
	});
}

export interface RuntimeLocalEventStoreOptions {
	dataDir: string;
	clock?: Clock;
	/** Override db path (tests). */
	dbPath?: string;
	partitionId?: string;
}

export interface RuntimeLocalEventStore extends DurableEventStore {
	fold<S>(
		streamId: string,
		opts: { initialState: S; handlers: FoldHandlers<S> },
	): Promise<FoldResult<S>>;
	loadSnapshot<S>(streamId: string): Promise<SnapshotRecord<S> | undefined>;
	/** @internal */
	journal(): SqliteJournal;
	close(): void;
}

export function createRuntimeLocalEventStore(
	options: RuntimeLocalEventStoreOptions,
): RuntimeLocalEventStore {
	const clock = options.clock ?? createManualClock();
	const dataDir = options.dataDir;
	mkdirSync(dataDir, { recursive: true });
	const dbPath = options.dbPath ?? defaultDbPath(dataDir);
	const driver = createNodeSqliteDriver({ path: dbPath });
	const storage = new SqliteJournal(driver, {
		clock,
		nativePragmas: true,
		partitionId: options.partitionId ?? "default",
	});
	const nextUlid = createUlidGenerator(clock);
	const quarantinedSeqs = new Set<string>();

	return Object.freeze({
		async append(
			streamId: string,
			events: EventInput[],
			appendOptions: AppendOptions,
		): Promise<AppendResult> {
			// Parse boundary for back-compat validation
			parseAppendContext(streamId, appendOptions);
			parseEventInputs(events);
			return storage.append(streamId, events, appendOptions);
		},

		async commit(request: DurableCommitRequest): Promise<DurableCommitResult> {
			parseAppendContext(request.streamId, request.append);
			if (request.events.length > 0) parseEventInputs([...request.events]);
			return storage.commit(request);
		},

		read(streamId: string, fromSeq = 1) {
			const parsedStreamId = parseStreamId(streamId);
			const startSeq = parseExpectedSeq(fromSeq, "fromSeq");
			return storage.read(parsedStreamId, startSeq);
		},

		readAll(options?: ReadAllOptions): AsyncIterable<PositionedEvent> {
			return storage.readAll(options);
		},

		subscribe(
			filter: StreamFilter,
			handler: (event: EventEnvelope) => void | Promise<void>,
		) {
			return storage.subscribe(filter, handler);
		},

		async snapshot(streamId: string, state: JsonValue, seq: number) {
			const parsedStreamId = parseStreamId(streamId);
			const snapshotSeq = parseExpectedSeq(seq, "seq");
			try {
				return await storage.snapshot(parsedStreamId, state, snapshotSeq);
			} catch (error) {
				if (error instanceof SnapshotAheadError) {
					throw new OptimisticSequenceConflictError(
						parsedStreamId,
						snapshotSeq,
						error.headSeq,
					);
				}
				throw error;
			}
		},

		async loadSnapshot<S>(streamId: string) {
			return storage.loadSnapshot<S>(parseStreamId(streamId));
		},

		getStreamHead(streamId: string) {
			return storage.getStreamHead(parseStreamId(streamId));
		},

		async claimSubscription(
			options: ClaimSubscriptionOptions,
		): Promise<SubscriptionLease> {
			return storage.claimSubscription(options);
		},

		async loadCheckpoint(options: {
			subscriptionId: string;
			partitionId: string;
		}): Promise<SubscriptionCheckpoint | undefined> {
			return storage.loadCheckpoint(options);
		},

		async commitCheckpoint(options: {
			subscriptionId: string;
			partitionId: string;
			position: bigint;
			fenceToken: bigint;
		}): Promise<SubscriptionCheckpoint> {
			return storage.commitCheckpoint(options);
		},

		async resetCheckpoint(options: {
			subscriptionId: string;
			partitionId: string;
			position: bigint;
			administrative: true;
			holderId: string;
		}): Promise<SubscriptionCheckpoint> {
			return storage.resetCheckpoint(options);
		},

		async fold<S>(
			streamId: string,
			foldOptions: { initialState: S; handlers: FoldHandlers<S> },
		): Promise<FoldResult<S>> {
			const parsedStreamId = parseStreamId(streamId);
			const handlers = normalizeHandlers(foldOptions.handlers);
			let state = cloneRequired(
				foldOptions.initialState,
				"foldOptions.initialState",
			);
			const quarantined: FoldResult<S>["quarantined"] = [];
			const events: EventEnvelope[] = [];
			for await (const event of storage.read(parsedStreamId)) {
				events.push(event);
			}

			for (const event of events) {
				const quarantineKey = `${parsedStreamId}:${event.seq}`;
				if (isQuarantineEvent(event) || quarantinedSeqs.has(quarantineKey)) {
					continue;
				}
				const handler = handlers.get(event.type);
				if (!handler) {
					continue;
				}

				try {
					state = cloneJson(handler(cloneJson(state), cloneJson(event)));
				} catch (caught) {
					const cause =
						caught instanceof Error ? caught : new Error(String(caught));
					const quarantine = await appendQuarantine({
						storage,
						streamId: parsedStreamId,
						event,
						cause,
						clock,
						nextUlid,
						quarantinedSeqs,
					});
					quarantined.push({
						offendingSeq: event.seq,
						quarantineSeq: quarantine.seq,
						type: quarantine.type,
						reason: String(
							// SAFETY: assertion to `quarantine.data as { reason?: string }` is required at this boundary.
							(quarantine.data as { reason?: string }).reason ?? "",
						),
					});
				}
			}

			return Object.freeze({
				streamId: parsedStreamId,
				seq: storage.getStreamLength(parsedStreamId),
				state: cloneJson(state),
				quarantined,
			});
		},

		journal() {
			return storage;
		},

		close() {
			storage.close();
		},
	}) satisfies RuntimeLocalEventStore & EventStore;
}

async function appendQuarantine({
	storage,
	streamId,
	event,
	cause,
	clock,
	nextUlid,
	quarantinedSeqs,
}: {
	storage: SqliteJournal;
	streamId: string;
	event: EventEnvelope;
	cause: Error;
	clock: Clock;
	nextUlid: () => string;
	quarantinedSeqs: Set<string>;
}): Promise<EventEnvelope> {
	const quarantineKey = `${streamId}:${event.seq}`;
	// The stream, not `quarantinedSeqs`, decides whether this event has already
	// been quarantined. The set lives in one store instance, so it is empty
	// after a restart — and a fold is not read-only, so re-folding a stream
	// that contains a poison event is the ordinary case (a projection rebuild,
	// a replica catching up). Gating this scan on the set meant the second
	// fold *after a restart* appended a second marker for the same event:
	// unbounded stream growth on a real clock, and a hard
	// `UNIQUE constraint failed: events.id` on a manual one. The set is still
	// the fast path inside a single instance; this is the durable one.
	for await (const candidate of storage.read(streamId)) {
		if (
			isQuarantineEvent(candidate) &&
			// SAFETY: assertion to `candidate.data as { offendingSeq?: number }` is required at this boundary.
			(candidate.data as { offendingSeq?: number }).offendingSeq === event.seq
		) {
			quarantinedSeqs.add(quarantineKey);
			return candidate;
		}
	}

	quarantinedSeqs.add(quarantineKey);
	const reason = cause instanceof Error ? cause.message : String(cause);
	const aggregate = event.type.split(".")[0] ?? "event";
	const input = parseEventInput({
		type: `${aggregate}.Quarantined`,
		data: {
			offendingSeq: event.seq,
			offendingType: event.type,
			reason,
		},
		meta: {
			quarantines: event.id,
		},
	});
	void nextUlid;
	void clock;
	// Quarantine must not bypass fencing: use current owner_epoch when fenced.
	const head = storage.getStreamHead(streamId);
	const appendOpts: AppendOptions = {
		expectedSeq: storage.getStreamLength(streamId),
		actor: { kind: "system", id: "runtime-local" },
		tenant: event.tenant,
		causationId: event.id,
	};
	if (head && head.ownerEpoch > 0n) {
		appendOpts.fenceToken = head.ownerEpoch;
	}
	if (event.correlationId !== undefined) {
		appendOpts.correlationId = event.correlationId;
	}
	const result = await storage.append(
		streamId,
		[
			{
				type: input.type,
				v: input.v,
				data: input.data,
				// SAFETY: assertion to `input.meta as JsonObject` is required at this boundary.
				meta: input.meta as JsonObject,
			},
		],
		appendOpts,
	);
	// SAFETY: assertion to `result.appended[0] as EventEnvelope` is required at this boundary.
	return result.appended[0] as EventEnvelope;
}

function normalizeHandlers<S>(
	handlers: FoldHandlers<S>,
): Map<string, FoldHandlers<S>[string]> {
	if (!handlers || !isJsonObject(handlers) || Array.isArray(handlers)) {
		throw new TypeError("foldOptions.handlers must be an object");
	}
	const entries: Array<[string, FoldHandlers<S>[string]]> = [];
	for (const [type, handler] of Object.entries(handlers)) {
		if (handler instanceof Function) {
			entries.push([type, handler]);
		}
	}
	return new Map(entries);
}

function isQuarantineEvent(event: EventEnvelope): boolean {
	return event.type.endsWith(".Quarantined");
}

function cloneJson<T>(value: T): T {
	if (value === undefined) {
		return value;
	}
	if (structuredClone instanceof Function) {
		return structuredClone(value);
	}
	const cloned = parseJsonValue(JSON.stringify(value));
	// SAFETY: JSON round-trip preserves the caller-owned event snapshot type.
	return cloned as T;
}

function cloneRequired<T>(value: T, fieldName: string): T {
	if (value === undefined) {
		throw new TypeError(`${fieldName} is required`);
	}
	return cloneJson(value);
}

export async function collectStream(
	store: Pick<RuntimeLocalEventStore, "read">,
	streamId: string,
	fromSeq?: number,
): Promise<EventEnvelope[]> {
	const events: EventEnvelope[] = [];
	for await (const event of store.read(streamId, fromSeq)) {
		events.push(event);
	}
	return events;
}

// keep parse imports used for side-effect validation paths
export type { ParsedAppendContext, ParsedEventInput };

void parseEventEnvelope;
void join;
