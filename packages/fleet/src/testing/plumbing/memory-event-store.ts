/**
 * `createMemoryEventStore`: the in-memory `FleetEventStore` every lane tests
 * against (design §11.2 step 5, §7.3). Plumbing of the contract commit.
 *
 * It follows the append rules of the durable SQLite journal
 * (`@hobo/storage-sqlite`): per-stream `expectedSeq` compare-and-set, applied
 * only when the batch has new events; `meta.idempotencyKey` deduplication
 * scoped per stream (an already-committed key is returned in `deduped`, also
 * on a retry with a stale `expectedSeq`); single-writer fencing through
 * `fenceToken`; and `readAll` over every stream in append order, with global
 * positions starting at 1.
 */
import { randomUUID } from "node:crypto";
import {
	type AppendOptions,
	type AppendResult,
	createEventEnvelope,
	type EventEnvelope,
	type EventInput,
	type EventPosition,
	type JsonValue,
	MissingFenceError,
	OptimisticSequenceConflictError,
	type PositionedEvent,
	type SnapshotRecord,
	StaleFenceError,
	type StreamFilter,
	type StreamHead,
} from "@hobo/core";
import type { FleetEventStore } from "../../ports.js";
import { createDeliveryQueue, type DeliveryQueue } from "./stream.js";

type StreamState = {
	readonly events: EventEnvelope[];
	readonly byKey: Map<string, EventEnvelope>;
	ownerEpoch: bigint;
};

/** In-memory `FleetEventStore`: per-stream `expectedSeq`, `meta.idempotencyKey`, `readAll` in append order. */
export function createMemoryEventStore(): FleetEventStore {
	const streams = new Map<string, StreamState>();
	const log: PositionedEvent[] = [];
	const subscribers = new Set<
		Readonly<{
			filter: StreamFilter;
			handler: (event: EventEnvelope) => void | Promise<void>;
			queue: DeliveryQueue;
		}>
	>();

	const streamOf = (streamId: string): StreamState => {
		const existing = streams.get(streamId);
		if (existing !== undefined) return existing;
		const created: StreamState = {
			events: [],
			byKey: new Map(),
			ownerEpoch: 0n,
		};
		streams.set(streamId, created);
		return created;
	};

	return {
		async append(
			streamId: string,
			events: EventInput[],
			opts: AppendOptions,
		): Promise<AppendResult> {
			if (streamId.length === 0) throw new TypeError("streamId is empty");
			if (!Number.isSafeInteger(opts.expectedSeq) || opts.expectedSeq < 0)
				throw new TypeError("expectedSeq must be a non-negative integer");
			const stream = streamOf(streamId);

			const deduped: EventEnvelope[] = [];
			const toWrite: EventInput[] = [];
			const batchKeys = new Set<string>();
			const batchDuplicates: string[] = [];
			for (const input of events) {
				const key = idempotencyKeyOf(input);
				if (key !== undefined) {
					const existing = stream.byKey.get(key);
					if (existing !== undefined) {
						deduped.push(existing);
						continue;
					}
					if (batchKeys.has(key)) {
						batchDuplicates.push(key);
						continue;
					}
					batchKeys.add(key);
				}
				toWrite.push(input);
			}
			if (toWrite.length === 0)
				return { streamId, appended: [], deduped: copyAll(deduped) };

			let nextEpoch = stream.ownerEpoch;
			if (stream.ownerEpoch > 0n) {
				if (opts.fenceToken === undefined)
					throw new MissingFenceError(streamId, stream.ownerEpoch);
				if (opts.fenceToken < stream.ownerEpoch)
					throw new StaleFenceError(
						streamId,
						opts.fenceToken,
						stream.ownerEpoch,
					);
				nextEpoch = opts.fenceToken;
			} else if (opts.fenceToken !== undefined && opts.fenceToken > 0n) {
				nextEpoch = opts.fenceToken;
			}

			const head = stream.events.length;
			if (head !== opts.expectedSeq)
				throw new OptimisticSequenceConflictError(
					streamId,
					opts.expectedSeq,
					head,
				);

			// Build every envelope before storing any, so a bad input appends nothing.
			const ts = new Date().toISOString();
			const built = toWrite.map((input, index) =>
				createEventEnvelope({
					id: randomUUID(),
					type: input.type,
					v: input.v ?? 1,
					streamId,
					seq: head + index + 1,
					ts,
					actor: opts.actor,
					tenant: opts.tenant,
					project: opts.project,
					causationId: opts.causationId,
					correlationId: opts.correlationId,
					lane: opts.lane,
					data: input.data ?? {},
					meta: input.meta,
				}),
			);

			stream.ownerEpoch = nextEpoch;
			const firstPosition = positionOf(log.length + 1);
			for (const [index, envelope] of built.entries()) {
				stream.events.push(envelope);
				const key = idempotencyKeyOf(toWrite[index]);
				if (key !== undefined) stream.byKey.set(key, envelope);
				log.push({ position: positionOf(log.length + 1), event: envelope });
			}
			const lastPosition = positionOf(log.length);
			for (const key of batchDuplicates) {
				const envelope = stream.byKey.get(key);
				if (envelope !== undefined) deduped.push(envelope);
			}

			for (const subscriber of subscribers) {
				for (const envelope of built) {
					if (!matches(subscriber.filter, envelope)) continue;
					const copy = structuredClone(envelope);
					subscriber.queue.push(async () => {
						await subscriber.handler(copy);
					});
				}
			}
			return {
				streamId,
				appended: copyAll(built),
				deduped: copyAll(deduped),
				firstPosition,
				lastPosition,
			};
		},

		async *read(streamId: string, fromSeq = 1): AsyncIterable<EventEnvelope> {
			const events = [...(streams.get(streamId)?.events ?? [])];
			for (const event of events) {
				if (event.seq >= fromSeq) yield structuredClone(event);
			}
		},

		subscribe(filter, handler) {
			const subscriber = { filter, handler, queue: createDeliveryQueue() };
			subscribers.add(subscriber);
			return {
				unsubscribe() {
					subscribers.delete(subscriber);
					subscriber.queue.stop();
				},
			};
		},

		async snapshot(
			streamId: string,
			state: JsonValue,
			seq: number,
		): Promise<SnapshotRecord> {
			const head = streams.get(streamId)?.events.length ?? 0;
			if (!Number.isSafeInteger(seq) || seq < 0 || seq > head)
				throw new OptimisticSequenceConflictError(streamId, seq, head);
			return {
				streamId,
				seq,
				state: structuredClone(state),
				savedAt: new Date().toISOString(),
			};
		},

		getStreamHead(streamId: string): StreamHead | undefined {
			const stream = streams.get(streamId);
			if (stream === undefined) return undefined;
			return {
				streamId,
				revision: stream.events.length,
				ownerEpoch: stream.ownerEpoch,
			};
		},

		async *readAll(
			options?: Readonly<{ after?: EventPosition; limit?: number }>,
		): AsyncIterable<PositionedEvent> {
			const after = options?.after ?? 0n;
			const limit = options?.limit ?? Number.POSITIVE_INFINITY;
			let yielded = 0;
			for (const entry of log.slice()) {
				if (yielded >= limit) return;
				if (entry.position <= after) continue;
				yielded += 1;
				yield { position: entry.position, event: structuredClone(entry.event) };
			}
		},
	};
}

function positionOf(value: number): EventPosition {
	// SAFETY: positions are 1-based counts of appended events, so always a non-negative integer.
	return BigInt(value) as EventPosition;
}

function idempotencyKeyOf(input: EventInput | undefined): string | undefined {
	const key = input?.meta?.idempotencyKey;
	return isText(key) && key.length > 0 ? key : undefined;
}

function isText(value: JsonValue | undefined): value is string {
	return Object.prototype.toString.call(value) === "[object String]";
}

function matches(filter: StreamFilter, event: EventEnvelope): boolean {
	return (
		(filter.streamId === undefined || filter.streamId === event.streamId) &&
		(filter.type === undefined || filter.type === event.type)
	);
}

function copyAll(events: readonly EventEnvelope[]): EventEnvelope[] {
	return events.map((event) => structuredClone(event));
}
