// A small in-memory event store for the executor tests. It implements exactly
// the slice of the durable event-store port the executors use — append under
// optimistic `seq` with idempotency keys, per-stream read, and catch-up read
// by position — with the same refusals the real store makes.
import {
	type AppendOptions,
	type AppendResult,
	type EventEnvelope,
	type EventInput,
	type EventPosition,
	OptimisticSequenceConflictError,
	type PositionedEvent,
	parseEventPosition,
	type ReadAllOptions,
	type StreamHead,
} from "@hobo/core";

export interface MemoryEventStore {
	append(
		streamId: string,
		events: EventInput[],
		opts: AppendOptions,
	): Promise<AppendResult>;
	read(streamId: string, fromSeq?: number): AsyncIterable<EventEnvelope>;
	readAll(options?: ReadAllOptions): AsyncIterable<PositionedEvent>;
	getStreamHead(streamId: string): StreamHead | undefined;
	/** Number of events in the store. */
	size(): number;
	/** When set, every append is refused: a quiesced writer. */
	quiesced: boolean;
}

export function createMemoryEventStore(clock: () => string): MemoryEventStore {
	const log: PositionedEvent[] = [];
	const heads = new Map<string, number>();
	const keys = new Map<string, EventEnvelope>();
	let ids = 0;
	const store: MemoryEventStore = {
		quiesced: false,
		async append(streamId, events, opts) {
			if (store.quiesced) throw new Error("the writer is quiesced");
			const appended: EventEnvelope[] = [];
			const deduped: EventEnvelope[] = [];
			const fresh: EventInput[] = [];
			for (const input of events) {
				const key = input.meta?.idempotencyKey;
				const existing = key === undefined ? undefined : keys.get(String(key));
				if (existing === undefined) fresh.push(input);
				else deduped.push(existing);
			}
			const head = heads.get(streamId) ?? 0;
			if (fresh.length > 0 && opts.expectedSeq !== head) {
				throw new OptimisticSequenceConflictError(
					streamId,
					opts.expectedSeq,
					head,
				);
			}
			let seq = head;
			let firstPosition: EventPosition | undefined;
			let lastPosition: EventPosition | undefined;
			for (const input of fresh) {
				seq += 1;
				ids += 1;
				const envelope: EventEnvelope = {
					id: `evt-${String(ids).padStart(6, "0")}`,
					type: input.type,
					v: input.v ?? 1,
					streamId,
					seq,
					ts: clock(),
					actor: opts.actor,
					tenant: opts.tenant,
					...(opts.project === undefined
						? undefined
						: { project: opts.project }),
					...(opts.causationId === undefined
						? undefined
						: { causationId: opts.causationId }),
					...(opts.correlationId === undefined
						? undefined
						: { correlationId: opts.correlationId }),
					...(opts.lane === undefined ? undefined : { lane: opts.lane }),
					data: input.data,
					...(input.meta === undefined ? undefined : { meta: input.meta }),
				};
				const position = parseEventPosition(log.length + 1);
				log.push({ position, event: envelope });
				firstPosition ??= position;
				lastPosition = position;
				appended.push(envelope);
				const key = input.meta?.idempotencyKey;
				if (key !== undefined) keys.set(String(key), envelope);
			}
			heads.set(streamId, seq);
			return {
				streamId,
				appended,
				deduped,
				...(firstPosition === undefined ? undefined : { firstPosition }),
				...(lastPosition === undefined ? undefined : { lastPosition }),
			};
		},
		async *read(streamId, fromSeq = 1) {
			for (const item of log) {
				if (item.event.streamId === streamId && item.event.seq >= fromSeq) {
					yield item.event;
				}
			}
		},
		async *readAll(options = {}) {
			const after = options.after ?? parseEventPosition(0);
			let yielded = 0;
			for (const item of log) {
				if (item.position <= after) continue;
				if (options.limit !== undefined && yielded >= options.limit) return;
				yielded += 1;
				yield item;
			}
		},
		getStreamHead(streamId) {
			const revision = heads.get(streamId);
			return revision === undefined
				? undefined
				: { streamId, revision, ownerEpoch: 0n };
		},
		size() {
			return log.length;
		},
	};
	return store;
}
