/**
 * The A15 adapter harness: hosts the journal store in `@hobo/conformance`'s
 * `runEventStoreConformance` (R6), whose factory is synchronous, reopens a
 * data directory, and needs `close()` and `fold()`.
 *
 * - The factory returns at once; every method awaits the store being opened.
 * - A "data directory" names one journal stream: reopening it opens a new
 *   connection (a new store instance with an empty cache) on the same stream.
 * - `fold` follows `@hobo/runtime-local`: a handler that throws quarantines its
 *   event by appending one `<family>.Quarantined` event, once per event.
 * - The crash probe starts batches of three events and closes the connection
 *   while they are in flight; after reopening, every acknowledged batch is
 *   present and every batch is present whole or not at all.
 */
import type {
	AppendOptions,
	EventEnvelope,
	FoldHandlers,
	JsonValue,
} from "@hobo/core";
import type {
	CreateRuntimeLocalEventStore,
	RuntimeLocalEventStoreLike,
} from "../../../conformance/src/suites/eventstore.js";
import {
	type JournalEventStore,
	openJournalStore,
} from "../../src/journal/store.js";
import type { JournalTransport } from "../../src/journal/transport.js";

export type OpenTransport = (
	dataDir: string | undefined,
) => Promise<JournalTransport>;

export function journalStoreFactory(
	openTransport: OpenTransport,
): CreateRuntimeLocalEventStore {
	return (options) => {
		const ready: Promise<JournalEventStore> = openTransport(
			options?.dataDir,
		).then((transport) => openJournalStore(transport));
		const store: RuntimeLocalEventStoreLike = {
			async append(streamId, events, opts) {
				return (await ready).append(streamId, events, opts);
			},
			async *read(streamId, fromSeq) {
				yield* (await ready).read(streamId, fromSeq);
			},
			subscribe(filter, handler) {
				const subscription = ready.then((opened) =>
					opened.subscribe(filter, handler),
				);
				return {
					unsubscribe() {
						void subscription.then((held) => held.unsubscribe());
					},
				};
			},
			async snapshot(streamId, state, seq) {
				return (await ready).snapshot(streamId, state, seq);
			},
			close() {
				void ready.then((opened) => opened.close());
			},
			async fold<S>(
				streamId: string,
				opts: { initialState: S; handlers: FoldHandlers<S> },
			) {
				return foldJournal(await ready, streamId, opts);
			},
		};
		return store;
	};
}

async function foldJournal<S>(
	store: JournalEventStore,
	streamId: string,
	opts: { initialState: S; handlers: FoldHandlers<S> },
): Promise<{
	streamId: string;
	seq: number;
	state: S;
	quarantined: JsonValue[];
}> {
	const events = await collect(store.read(streamId));
	let state = structuredClone(opts.initialState);
	let head = events.length;
	const quarantined: JsonValue[] = [];
	for (const event of events) {
		if (event.type.endsWith(".Quarantined")) continue;
		if (alreadyQuarantined(events, event.seq)) continue;
		const handler = opts.handlers[event.type];
		if (handler === undefined) continue;
		try {
			state = structuredClone(
				handler(structuredClone(state), structuredClone(event)),
			);
		} catch (caught) {
			const reason = caught instanceof Error ? caught.message : String(caught);
			const family = event.type.split(".")[0] ?? "event";
			const options: AppendOptions = {
				expectedSeq: head,
				actor: { kind: "system", id: "fleet-journal-harness" },
				tenant: event.tenant,
				causationId: event.id,
			};
			const result = await store.append(
				streamId,
				[
					{
						type: `${family}.Quarantined`,
						data: {
							offendingSeq: event.seq,
							offendingType: event.type,
							reason,
						},
						meta: { quarantines: event.id },
					},
				],
				options,
			);
			head += result.appended.length;
			const marker = result.appended[0];
			quarantined.push({
				offendingSeq: event.seq,
				quarantineSeq: marker?.seq ?? 0,
				type: marker?.type ?? `${family}.Quarantined`,
				reason,
			});
		}
	}
	return { streamId, seq: head, state, quarantined };
}

function alreadyQuarantined(events: readonly EventEnvelope[], seq: number) {
	return events.some(
		(candidate) =>
			candidate.type.endsWith(".Quarantined") &&
			Object.prototype.toString.call(candidate.data) === "[object Object]" &&
			Object.entries(candidate.data ?? {}).some(
				([key, value]) => key === "offendingSeq" && value === seq,
			),
	);
}

/** The crash probe: batches of three in flight when the connection is closed. */
export function journalCrashProbe(): (
	createStore: CreateRuntimeLocalEventStore,
	dataDir: string,
) => Promise<boolean> {
	return async (createStore, dataDir) => {
		const streamId = "durability:crash";
		const writer = createStore({ dataDir });
		const acked: number[] = [];
		let expected = 0;
		const attempts: Promise<void>[] = [];
		for (let batch = 0; batch < 8; batch += 1) {
			const expectedSeq = expected;
			expected += 3;
			const options: AppendOptions = {
				expectedSeq,
				actor: { kind: "system", id: "fleet-journal-crash" },
				tenant: "conformance-tenant",
				correlationId: `batch-${batch}`,
			};
			const attempt = writer
				.append(
					streamId,
					[1, 2, 3].map((n) => ({
						type: "crash.Appended",
						data: { batch, n },
					})),
					options,
				)
				.then(
					(result) => {
						for (const event of result.appended) acked.push(event.seq);
					},
					() => undefined,
				);
			attempts.push(attempt);
			if (batch === 4) writer.close();
			await attempt;
		}
		await Promise.all(attempts);
		const reader = createStore({ dataDir });
		try {
			const events = await collect(reader.read(streamId));
			if (!acked.every((seq) => events.some((event) => event.seq === seq)))
				return false;
			const groups = new Map<string, number>();
			for (const event of events) {
				const group = event.correlationId ?? "";
				groups.set(group, (groups.get(group) ?? 0) + 1);
			}
			if ([...groups.values()].some((count) => count !== 3)) return false;
			return events.every((event, index) => event.seq === index + 1);
		} finally {
			reader.close();
		}
	};
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of items) out.push(item);
	return out;
}
