/**
 * `runJournalConformance` (design §7.3, O11): what every `FleetEventStore`
 * must do for the authority — per-stream compare-and-set on `expectedSeq`,
 * `meta.idempotencyKey` deduplication, ordered reads of one stream, and
 * `readAll` over every stream in append order.
 *
 * Every assertion writes to streams named with a fresh random id, so the suite
 * also runs against a store shared with other writers (a journal on a live
 * server): `readAll` results are filtered to the assertion's own streams.
 */
import { randomUUID } from "node:crypto";
import type {
	AppendOptions,
	EventEnvelope,
	EventInput,
	PositionedEvent,
} from "@hobo/core";
import type { FleetEventStore } from "../../ports.js";
import {
	type ConformanceAssertion,
	ensure,
	eventually,
	fails,
	pause,
} from "./assertion.js";

export type JournalMake = () => Promise<FleetEventStore>;

const OPTIONS: AppendOptions = {
	expectedSeq: 0,
	actor: { kind: "service", id: "hobo-fleet-conformance" },
	tenant: "conformance",
};

const at = (expectedSeq: number): AppendOptions => ({
	...OPTIONS,
	expectedSeq,
});

const stream = (label: string) => `fleet-conformance-${label}-${randomUUID()}`;

const event = (type: string, n: number): EventInput => ({
	type,
	data: { n },
});

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of items) out.push(item);
	return out;
}

async function readStream(
	store: FleetEventStore,
	streamId: string,
	fromSeq?: number,
): Promise<EventEnvelope[]> {
	return collect(store.read(streamId, fromSeq));
}

async function readAllOf(
	store: FleetEventStore,
	streams: readonly string[],
	options?: Parameters<FleetEventStore["readAll"]>[0],
): Promise<PositionedEvent[]> {
	const all = await collect(store.readAll(options));
	return all.filter((entry) => streams.includes(entry.event.streamId));
}

const label = (entry: PositionedEvent) =>
	`${entry.event.streamId}#${entry.event.seq}`;

/** The journal assertions, in the order they are registered. */
export const JOURNAL_ASSERTIONS: readonly ConformanceAssertion<JournalMake>[] =
	[
		{
			name: "append to a new stream with expectedSeq 0 numbers its events from 1",
			async check(make) {
				const store = await make();
				const id = stream("number");
				const result = await store.append(
					id,
					[event("fleet.Test", 1), event("fleet.Test", 2)],
					at(0),
				);
				const seqs = result.appended.map((entry) => entry.seq);
				ensure(
					seqs.join(",") === "1,2",
					`appended seq ${seqs.join(",")}, want 1,2`,
				);
				ensure(
					result.appended.every((entry) => entry.streamId === id),
					"appended events name another stream",
				);
			},
		},
		{
			name: "a stale expectedSeq is refused and appends nothing",
			async check(make) {
				const store = await make();
				const id = stream("stale");
				await store.append(id, [event("fleet.Test", 1)], at(0));
				const refused = await fails(async () => {
					await store.append(id, [event("fleet.Test", 2)], at(0));
				});
				ensure(refused, "an append with a stale expectedSeq was accepted");
				const held = await readStream(store, id);
				ensure(
					held.length === 1,
					`the stream holds ${held.length} events after a refused append, want 1`,
				);
				await store.append(id, [event("fleet.Test", 3)], at(1));
				const after = await readStream(store, id);
				ensure(
					JSON.stringify(after.map((entry) => entry.data)) ===
						JSON.stringify([{ n: 1 }, { n: 3 }]),
					"an append with the current expectedSeq was not taken",
				);
			},
		},
		{
			name: "read returns a stream's events in order from fromSeq",
			async check(make) {
				const store = await make();
				const id = stream("read");
				await store.append(
					id,
					[1, 2, 3, 4].map((n) => event(`fleet.Test${n}`, n)),
					at(0),
				);
				const all = await readStream(store, id);
				ensure(
					all.map((entry) => entry.seq).join(",") === "1,2,3,4",
					"read did not return seq 1..4 in order",
				);
				ensure(
					all.map((entry) => entry.type).join(",") ===
						"fleet.Test1,fleet.Test2,fleet.Test3,fleet.Test4",
					"read returned events out of append order",
				);
				const tail = await readStream(store, id, 3);
				ensure(
					tail.map((entry) => entry.seq).join(",") === "3,4",
					`read from seq 3 returned ${tail.map((entry) => entry.seq).join(",")}, want 3,4`,
				);
			},
		},
		{
			name: "streams are isolated from one another",
			async check(make) {
				const store = await make();
				const first = stream("isolated-a");
				const second = stream("isolated-b");
				await store.append(first, [event("fleet.First", 1)], at(0));
				await store.append(second, [event("fleet.Second", 1)], at(0));
				await store.append(second, [event("fleet.Second", 2)], at(1));
				const read = await readStream(store, first);
				ensure(
					read.length === 1 &&
						read[0]?.type === "fleet.First" &&
						read[0]?.streamId === first,
					"read of one stream returned another stream's events",
				);
				const empty = await readStream(store, stream("never-written"));
				ensure(empty.length === 0, "a stream never written is not empty");
			},
		},
		{
			name: "a repeated meta.idempotencyKey is deduplicated, not appended again",
			async check(make) {
				const store = await make();
				const id = stream("idempotent");
				const keyed: EventInput = {
					type: "fleet.Test",
					data: { n: 1 },
					meta: { idempotencyKey: "conformance-key" },
				};
				await store.append(id, [keyed], at(0));
				const again = await store.append(id, [keyed], at(1));
				ensure(
					again.appended.length === 0,
					"a repeated idempotency key appended a second event",
				);
				ensure(
					again.deduped.length === 1 && again.deduped[0]?.seq === 1,
					"a repeated idempotency key did not return the committed event in deduped",
				);
				const held = await readStream(store, id);
				ensure(
					held.length === 1,
					`the stream holds ${held.length} events, want 1`,
				);
			},
		},
		{
			name: "type, version, data and meta round-trip",
			async check(make) {
				const store = await make();
				const id = stream("round-trip");
				await store.append(
					id,
					[
						{
							type: "fleet.WorkClaimed",
							v: 2,
							data: { digest: "0".repeat(32), slots: 3, labels: ["a", "b"] },
							meta: { busStream: "FLEET_CLAIMS", busSequence: 7 },
						},
					],
					at(0),
				);
				const [read] = await readStream(store, id);
				ensure(read !== undefined, "the appended event was not read back");
				ensure(read.type === "fleet.WorkClaimed", `type ${read.type}`);
				ensure(read.v === 2, `version ${read.v}, want 2`);
				ensure(
					JSON.stringify(read.data) ===
						JSON.stringify({
							digest: "0".repeat(32),
							slots: 3,
							labels: ["a", "b"],
						}),
					`data ${JSON.stringify(read.data)} did not round-trip`,
				);
				ensure(
					read.meta?.busStream === "FLEET_CLAIMS" &&
						read.meta?.busSequence === 7,
					`meta ${JSON.stringify(read.meta)} did not round-trip`,
				);
				ensure(read.tenant === "conformance", `tenant ${read.tenant}`);
			},
		},
		{
			name: "readAll yields every stream's events in append order with increasing positions",
			async check(make) {
				const store = await make();
				const first = stream("all-a");
				const second = stream("all-b");
				await store.append(first, [event("fleet.Test", 1)], at(0));
				await store.append(second, [event("fleet.Test", 1)], at(0));
				await store.append(first, [event("fleet.Test", 2)], at(1));
				const all = await readAllOf(store, [first, second]);
				ensure(
					all.map(label).join(",") ===
						[`${first}#1`, `${second}#1`, `${first}#2`].join(","),
					`readAll returned ${all.map(label).join(",")}, not append order`,
				);
				ensure(
					all.every(
						(entry, index) =>
							index === 0 || entry.position > (all[index - 1]?.position ?? 0n),
					),
					"readAll positions do not increase",
				);
			},
		},
		{
			name: "readAll after a position resumes just after it",
			async check(make) {
				const store = await make();
				const first = stream("after-a");
				const second = stream("after-b");
				await store.append(first, [event("fleet.Test", 1)], at(0));
				await store.append(second, [event("fleet.Test", 1)], at(0));
				await store.append(first, [event("fleet.Test", 2)], at(1));
				const all = await readAllOf(store, [first, second]);
				const middle = all[1];
				ensure(middle !== undefined, "readAll lost an event");
				const rest = await readAllOf(store, [first, second], {
					after: middle.position,
				});
				ensure(
					rest.map(label).join(",") === `${first}#2`,
					`readAll after the second event returned ${rest.map(label).join(",")}`,
				);
			},
		},
		{
			name: "readAll honours limit",
			async check(make) {
				const store = await make();
				const id = stream("limit");
				await store.append(
					id,
					[1, 2, 3].map((n) => event("fleet.Test", n)),
					at(0),
				);
				const [firstEvent] = await readAllOf(store, [id]);
				ensure(firstEvent !== undefined, "readAll lost an event");
				const limited = await collect(
					store.readAll({ after: firstEvent.position, limit: 1 }),
				);
				ensure(
					limited.length === 1,
					`readAll with limit 1 returned ${limited.length} events`,
				);
			},
		},
		{
			name: "subscribe delivers appended events that match its filter",
			async check(make) {
				const store = await make();
				const id = stream("subscribe");
				const seen: string[] = [];
				const subscription = store.subscribe({ streamId: id }, (received) => {
					seen.push(`${received.type}#${received.seq}`);
				});
				try {
					await store.append(id, [event("fleet.Wanted", 1)], at(0));
					await store.append(stream("other"), [event("fleet.Other", 1)], at(0));
					await eventually(
						() => seen.length >= 1,
						5_000,
						"subscribe delivered nothing",
					);
					await pause(50);
					ensure(
						seen.join(",") === "fleet.Wanted#1",
						`subscribe delivered ${seen.join(",")}, want only fleet.Wanted#1`,
					);
				} finally {
					subscription.unsubscribe();
				}
			},
		},
		{
			name: "an unsubscribed handler receives nothing more",
			async check(make) {
				const store = await make();
				const id = stream("unsubscribe");
				let seen = 0;
				const subscription = store.subscribe({ streamId: id }, () => {
					seen += 1;
				});
				await store.append(id, [event("fleet.Test", 1)], at(0));
				await eventually(
					() => seen === 1,
					5_000,
					"subscribe delivered nothing",
				);
				subscription.unsubscribe();
				await store.append(id, [event("fleet.Test", 2)], at(1));
				await pause(50);
				ensure(seen === 1, "a handler received an event after unsubscribe");
			},
		},
	];
