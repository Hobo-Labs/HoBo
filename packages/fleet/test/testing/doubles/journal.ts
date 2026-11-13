/**
 * Event stores broken in exactly one way each, keyed by the journal assertion
 * that must catch the break. Each wraps the in-memory event store.
 */
import type { EventEnvelope, PositionedEvent } from "@hobo/core";
import type { FleetEventStore } from "../../../src/ports.js";
import type { JournalMake } from "../../../src/testing/conformance/journal.js";
import { createMemoryEventStore } from "../../../src/testing/plumbing/index.js";

type Patch = (base: FleetEventStore) => Partial<FleetEventStore>;

const broken =
	(patch: Patch): JournalMake =>
	async () => {
		const base = createMemoryEventStore();
		return { ...base, ...patch(base) };
	};

async function* each<T>(items: readonly T[]): AsyncIterable<T> {
	for (const item of items) yield item;
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of items) out.push(item);
	return out;
}

export const BROKEN_JOURNALS: ReadonlyMap<string, JournalMake> = new Map([
	[
		"append to a new stream with expectedSeq 0 numbers its events from 1",
		broken((base) => ({
			async append(streamId, events, opts) {
				const result = await base.append(streamId, events, opts);
				return {
					...result,
					appended: result.appended.map((entry) => ({
						...entry,
						seq: entry.seq - 1,
					})),
				};
			},
		})),
	],
	[
		"a stale expectedSeq is refused and appends nothing",
		broken((base) => ({
			append(streamId, events, opts) {
				const head = base.getStreamHead?.(streamId)?.revision ?? 0;
				return base.append(streamId, events, { ...opts, expectedSeq: head });
			},
		})),
	],
	[
		"read returns a stream's events in order from fromSeq",
		broken((base) => ({
			read(streamId) {
				return base.read(streamId);
			},
		})),
	],
	[
		"streams are isolated from one another",
		broken((base) => ({
			async *read(streamId, fromSeq = 1) {
				const all = await collect(base.readAll());
				const mine = all.some((entry) => entry.event.streamId === streamId);
				if (!mine) return;
				for (const entry of all)
					if (entry.event.seq >= fromSeq) yield entry.event;
			},
		})),
	],
	[
		"a repeated meta.idempotencyKey is deduplicated, not appended again",
		broken((base) => ({
			append(streamId, events, opts) {
				return base.append(
					streamId,
					events.map((input) => ({
						...input,
						meta: { ...input.meta, idempotencyKey: crypto.randomUUID() },
					})),
					opts,
				);
			},
		})),
	],
	[
		"type, version, data and meta round-trip",
		broken((base) => ({
			async *read(streamId, fromSeq) {
				for await (const entry of base.read(streamId, fromSeq))
					yield { ...entry, v: 1, meta: undefined } satisfies EventEnvelope;
			},
		})),
	],
	[
		"readAll yields every stream's events in append order with increasing positions",
		broken((base) => ({
			async *readAll(options) {
				const all = await collect(base.readAll(options));
				// Keep positions but swap the first two events' bodies: order is wrong.
				const swapped = all.map((entry, index): PositionedEvent => {
					const other = index === 0 ? all[1] : index === 1 ? all[0] : entry;
					return { position: entry.position, event: (other ?? entry).event };
				});
				yield* each(options?.after === undefined ? swapped : all);
			},
		})),
	],
	[
		"readAll after a position resumes just after it",
		broken((base) => ({
			readAll(options) {
				return base.readAll({ limit: options?.limit });
			},
		})),
	],
	[
		"readAll honours limit",
		broken((base) => ({
			readAll(options) {
				return base.readAll({ after: options?.after });
			},
		})),
	],
	[
		"subscribe delivers appended events that match its filter",
		broken((base) => ({
			subscribe(_filter, handler) {
				return base.subscribe({}, handler);
			},
		})),
	],
	[
		"an unsubscribed handler receives nothing more",
		broken((base) => ({
			subscribe(filter, handler) {
				base.subscribe(filter, handler);
				return { unsubscribe() {} };
			},
		})),
	],
]);
