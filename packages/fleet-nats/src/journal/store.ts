/**
 * The journal `FleetEventStore` over a `JournalTransport` (L36).
 *
 * Every append is one message holding the batch on `fleet.journal.<streamId>`,
 * published only if the subject's last stream sequence is still the one this
 * store read: the server's `Nats-Expected-Last-Subject-Sequence` check is the
 * compare-and-set, so replicas agree without a leader. Before writing, the
 * store catches its cache of the stream up from the journal (head, owner
 * epoch, committed idempotency keys), so its rules are those of
 * `createMemoryEventStore` and the SQLite journal, across replicas: per-stream
 * `expectedSeq`, `meta.idempotencyKey` deduplication (also on a retry with a
 * stale `expectedSeq`), single-writer fencing, and `readAll` in stream order.
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
	type Subscription,
} from "@hobo/core";
import type { FleetEventStore } from "@hobo/fleet";
import {
	decodeBatch,
	encodeBatch,
	JOURNAL_SUBJECTS,
	MAX_BATCH_EVENTS,
	positionOf,
	streamIdOfSubject,
	streamSequenceOf,
	subjectOfStream,
} from "./codec.js";
import {
	type JournalMessage,
	type JournalTransport,
	type JournalWatch,
	JournalWrongLastSequence,
} from "./transport.js";

/** The journal store; `close` ends its connection. */
export type JournalEventStore = FleetEventStore &
	Readonly<{
		getStreamHead(streamId: string): StreamHead | undefined;
		close(): Promise<void>;
	}>;

type Head = {
	/** Stream sequence of the last message of this stream this store has read (0: none). */
	messageSeq: number;
	revision: number;
	ownerEpoch: bigint;
	readonly byKey: Map<string, EventEnvelope>;
};

export function openJournalStore(
	transport: JournalTransport,
): JournalEventStore {
	const heads = new Map<string, Head>();
	const locks = new Map<string, Promise<void>>();
	/** Subscriptions still being set up; an append waits for them so it is not missed. */
	const starting = new Set<Promise<JournalWatch | undefined>>();

	const headOf = (streamId: string): Head => {
		const existing = heads.get(streamId);
		if (existing !== undefined) return existing;
		const created: Head = {
			messageSeq: 0,
			revision: 0,
			ownerEpoch: 0n,
			byKey: new Map(),
		};
		heads.set(streamId, created);
		return created;
	};

	const apply = (head: Head, message: JournalMessage, streamId: string) => {
		if (message.seq <= head.messageSeq) return;
		const batch = decodeBatch(message.data, streamId);
		for (const event of batch.events) {
			const key = idempotencyKeyOf(event.meta);
			if (key !== undefined && !head.byKey.has(key)) head.byKey.set(key, event);
		}
		head.revision = batch.events.at(-1)?.seq ?? head.revision;
		head.ownerEpoch = batch.ownerEpoch;
		head.messageSeq = message.seq;
	};

	/** Reads what other replicas appended to `streamId` since this store last looked. */
	const catchUp = async (streamId: string): Promise<Head> => {
		const head = headOf(streamId);
		const subject = subjectOfStream(streamId);
		const last = await transport.last(subject);
		if (last === undefined || last.seq <= head.messageSeq) return head;
		for await (const message of transport.messages(
			subject,
			head.messageSeq + 1,
		)) {
			if (message.seq > last.seq) break;
			apply(head, message, streamId);
		}
		return head;
	};

	/** One append per stream at a time in this store; other replicas are held off by the server. */
	const exclusive = async <T>(
		streamId: string,
		work: () => Promise<T>,
	): Promise<T> => {
		const before = locks.get(streamId) ?? Promise.resolve();
		let release = () => undefined;
		const mine = new Promise<void>((resolve) => {
			release = () => {
				resolve();
				return undefined;
			};
		});
		const tail = before.then(() => mine);
		locks.set(streamId, tail);
		await before;
		try {
			return await work();
		} finally {
			release();
			if (locks.get(streamId) === tail) locks.delete(streamId);
		}
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
			if (events.length > MAX_BATCH_EVENTS)
				throw new RangeError(
					`an append holds at most ${MAX_BATCH_EVENTS} events`,
				);
			await Promise.allSettled(starting);
			return exclusive(streamId, async () => {
				const head = await catchUp(streamId);

				const deduped: EventEnvelope[] = [];
				const toWrite: EventInput[] = [];
				const batchKeys = new Set<string>();
				const batchDuplicates: string[] = [];
				for (const input of events) {
					const key = idempotencyKeyOf(input.meta);
					if (key !== undefined) {
						const existing = head.byKey.get(key);
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

				let nextEpoch = head.ownerEpoch;
				if (head.ownerEpoch > 0n) {
					if (opts.fenceToken === undefined)
						throw new MissingFenceError(streamId, head.ownerEpoch);
					if (opts.fenceToken < head.ownerEpoch)
						throw new StaleFenceError(
							streamId,
							opts.fenceToken,
							head.ownerEpoch,
						);
					nextEpoch = opts.fenceToken;
				} else if (opts.fenceToken !== undefined && opts.fenceToken > 0n) {
					nextEpoch = opts.fenceToken;
				}

				if (head.revision !== opts.expectedSeq)
					throw new OptimisticSequenceConflictError(
						streamId,
						opts.expectedSeq,
						head.revision,
					);

				// Build every envelope before writing, so a bad input writes nothing.
				const ts = new Date().toISOString();
				const built = toWrite.map((input, index) =>
					createEventEnvelope({
						id: randomUUID(),
						type: input.type,
						v: input.v ?? 1,
						streamId,
						seq: head.revision + index + 1,
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

				const subject = subjectOfStream(streamId);
				const data = encodeBatch({ ownerEpoch: nextEpoch, events: built });
				let published: Readonly<{ seq: number }>;
				try {
					published = await transport.publish(subject, data, head.messageSeq);
				} catch (cause) {
					if (!(cause instanceof JournalWrongLastSequence)) throw cause;
					const moved = await catchUp(streamId);
					throw new OptimisticSequenceConflictError(
						streamId,
						opts.expectedSeq,
						moved.revision,
					);
				}
				apply(head, { seq: published.seq, subject, data }, streamId);

				for (const key of batchDuplicates) {
					const envelope = head.byKey.get(key);
					if (envelope !== undefined) deduped.push(envelope);
				}
				return {
					streamId,
					appended: copyAll(built),
					deduped: copyAll(deduped),
					firstPosition: positionOf(published.seq, 0),
					lastPosition: positionOf(published.seq, built.length - 1),
				};
			});
		},

		async *read(streamId: string, fromSeq = 1): AsyncIterable<EventEnvelope> {
			for await (const message of transport.messages(
				subjectOfStream(streamId),
				1,
			)) {
				for (const event of decodeBatch(message.data, streamId).events)
					if (event.seq >= fromSeq) yield event;
			}
		},

		subscribe(
			filter: StreamFilter,
			handler: (event: EventEnvelope) => void | Promise<void>,
		): Subscription {
			let stopped = false;
			let tail: Promise<void> = Promise.resolve();
			const deliver = (event: EventEnvelope) => {
				tail = tail.then(async () => {
					if (stopped) return;
					try {
						await handler(event);
					} catch {
						// A handler's failure is the handler's business; delivery goes on.
					}
				});
			};
			const subject =
				filter.streamId === undefined
					? JOURNAL_SUBJECTS
					: subjectOfStream(filter.streamId);
			const watch = (async (): Promise<JournalWatch | undefined> => {
				const from = (await transport.lastSequence()) + 1;
				if (stopped) return undefined;
				return transport.watch(subject, from, (message) => {
					if (stopped) return;
					const streamId = streamIdOfSubject(message.subject);
					for (const event of decodeBatch(message.data, streamId).events)
						if (filter.type === undefined || filter.type === event.type)
							deliver(event);
				});
			})();
			starting.add(watch);
			void watch.then(
				() => starting.delete(watch),
				() => starting.delete(watch),
			);
			return {
				unsubscribe() {
					stopped = true;
					void watch.then(
						(held) => held?.stop(),
						() => undefined,
					);
				},
			};
		},

		async snapshot(
			streamId: string,
			state: JsonValue,
			seq: number,
		): Promise<SnapshotRecord> {
			const head = await catchUp(streamId);
			if (!Number.isSafeInteger(seq) || seq < 0 || seq > head.revision)
				throw new OptimisticSequenceConflictError(streamId, seq, head.revision);
			return {
				streamId,
				seq,
				state: structuredClone(state),
				savedAt: new Date().toISOString(),
			};
		},

		/** The head as this store last read or wrote it; another replica may be ahead. */
		getStreamHead(streamId: string): StreamHead | undefined {
			const head = heads.get(streamId);
			if (head === undefined || head.messageSeq === 0) return undefined;
			return { streamId, revision: head.revision, ownerEpoch: head.ownerEpoch };
		},

		async *readAll(
			options?: Readonly<{ after?: EventPosition; limit?: number }>,
		): AsyncIterable<PositionedEvent> {
			const after = options?.after;
			const limit = options?.limit ?? Number.POSITIVE_INFINITY;
			if (limit <= 0) return;
			const from =
				after === undefined ? 1 : Math.max(1, streamSequenceOf(after));
			let yielded = 0;
			for await (const message of transport.messages(JOURNAL_SUBJECTS, from)) {
				const streamId = streamIdOfSubject(message.subject);
				const batch = decodeBatch(message.data, streamId);
				for (const [index, event] of batch.events.entries()) {
					const position = positionOf(message.seq, index);
					if (after !== undefined && position <= after) continue;
					yield { position, event };
					yielded += 1;
					if (yielded >= limit) return;
				}
			}
		},

		close: () => transport.close(),
	};
}

function idempotencyKeyOf(
	meta: Readonly<Record<string, JsonValue>> | undefined,
): string | undefined {
	const key = meta?.idempotencyKey;
	return Object.prototype.toString.call(key) === "[object String]" && key !== ""
		? String(key)
		: undefined;
}

function copyAll(events: readonly EventEnvelope[]): EventEnvelope[] {
	return events.map((event) => structuredClone(event));
}
