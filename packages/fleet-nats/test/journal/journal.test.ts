/**
 * The journal event store against a fake JetStream context (L36 isolated
 * checks): `runJournalConformance`, the A15 harness of
 * `runEventStoreConformance`, and the journal's own rules — one message per
 * append holding the batch, the expected-last-subject-sequence compare-and-set,
 * idempotency keys that survive a reopen, fencing, and parsed reads.
 */
import {
	type AppendOptions,
	type EventEnvelope,
	MissingFenceError,
	OptimisticSequenceConflictError,
	StaleFenceError,
} from "@hobo/core";
import { runJournalConformance } from "@hobo/fleet/testing";
import { describe, expect, it } from "vitest";
import { runEventStoreConformance } from "../../../conformance/src/suites/eventstore.js";
import {
	decodeBatch,
	encodeBatch,
	JOURNAL_STREAM,
	JOURNAL_SUBJECTS,
	MAX_BATCH_EVENTS,
	positionOf,
	streamIdOfSubject,
	subjectOfStream,
} from "../../src/journal/codec.js";
import { openJournalStore } from "../../src/journal/store.js";
import {
	createFakeJournalStream,
	createFakeJournalTransport,
	type FakeJournalStream,
} from "./fake-jetstream.js";
import { journalCrashProbe, journalStoreFactory } from "./harness.js";

const at = (
	expectedSeq: number,
	extra: Partial<AppendOptions> = {},
): AppendOptions => ({
	expectedSeq,
	actor: { kind: "service", id: "fleet-journal-test" },
	tenant: "t1",
	...extra,
});

const openOn = (stream: FakeJournalStream) =>
	openJournalStore(createFakeJournalTransport(stream));

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of items) out.push(item);
	return out;
}

describe("journal store on a fake JetStream context", () => {
	runJournalConformance(async () => openOn(createFakeJournalStream()));
});

describe("journal store shared by two replicas", () => {
	const shared = createFakeJournalStream();
	let turn = 0;
	// Alternate replicas: each assertion's store is a different instance on one stream.
	runJournalConformance(async () => {
		turn += 1;
		return openOn(shared);
	});
	it("ran on one stream", () => {
		expect(turn).toBeGreaterThan(0);
	});
});

describe("[A15] runEventStoreConformance through the adapter harness", () => {
	it("passes every assertion of the event-store suite", async () => {
		const streams = new Map<string, FakeJournalStream>();
		const streamFor = (dataDir: string | undefined) => {
			if (dataDir === undefined) return createFakeJournalStream();
			const existing = streams.get(dataDir);
			if (existing !== undefined) return existing;
			const created = createFakeJournalStream();
			streams.set(dataDir, created);
			return created;
		};
		let dirs = 0;
		const report = await runEventStoreConformance(
			journalStoreFactory(async (dataDir) =>
				createFakeJournalTransport(streamFor(dataDir)),
			),
			{
				backend: "fleet-journal (fake JetStream)",
				dataDirFactory: () => {
					dirs += 1;
					return `journal-${dirs}`;
				},
				removeDataDir: (dir) => {
					streams.delete(dir);
				},
				crashProbe: journalCrashProbe(),
			},
		);
		expect(report.assertions).toEqual({
			seqConditionalAppend: "pass",
			idempotencyKeyDedup: "pass",
			poisonEventQuarantine: "pass",
			idempotencyCollisionScopedPerStream: "pass",
			orderedReplayAfterReopen: "pass",
			dedupSurvivesReopen: "pass",
			replayEqualsLive: "pass",
			crashMidAppendAtomicity: "pass",
		});
	});
});

describe("journal layout", () => {
	it("writes one message per append, on fleet.journal.<streamId>, holding the whole batch", async () => {
		const stream = createFakeJournalStream();
		const store = openOn(stream);
		await store.append(
			"member-1",
			[
				{ type: "fleet.MemberEnrolled", data: { n: 1 } },
				{ type: "fleet.MemberActivated", data: { n: 2 } },
			],
			at(0),
		);
		expect(stream.messages).toHaveLength(1);
		const [message] = stream.messages;
		expect(message?.subject).toBe("fleet.journal.member-1");
		const batch = decodeBatch(message?.data ?? new Uint8Array(), "member-1");
		expect(batch.events.map((event) => event.seq)).toEqual([1, 2]);
		expect(batch.events.map((event) => event.type)).toEqual([
			"fleet.MemberEnrolled",
			"fleet.MemberActivated",
		]);
	});

	it("names the stream and its subjects as the topology does", () => {
		expect(JOURNAL_STREAM).toBe("FLEET_JOURNAL");
		expect(JOURNAL_SUBJECTS).toBe("fleet.journal.>");
	});

	it("sends the subject's last stream sequence as the expected last subject sequence", async () => {
		const stream = createFakeJournalStream();
		const store = openOn(stream);
		await store.append("a", [{ type: "fleet.Test", data: {} }], at(0));
		await store.append("b", [{ type: "fleet.Test", data: {} }], at(0));
		await store.append("a", [{ type: "fleet.Test", data: {} }], at(1));
		expect(stream.publishes).toEqual([
			{ subject: "fleet.journal.a", expected: 0, accepted: true },
			{ subject: "fleet.journal.b", expected: 0, accepted: true },
			{ subject: "fleet.journal.a", expected: 1, accepted: true },
		]);
	});

	it("maps any stream id to one subject token and back, injectively", () => {
		const ids = [
			"member-1",
			"fleet:abc",
			"a.b",
			"a%2Eb",
			"with space",
			"star*",
			"gt>",
			"ünïcode",
			"",
		].filter((id) => id.length > 0);
		const subjects = ids.map(subjectOfStream);
		expect(new Set(subjects).size).toBe(ids.length);
		for (const [index, subject] of subjects.entries()) {
			const token = subject.slice("fleet.journal.".length);
			expect(token).toMatch(/^[A-Za-z0-9_:%-]+$/);
			expect(streamIdOfSubject(subject)).toBe(ids[index]);
		}
	});

	it("refuses a subject outside the journal and one that does not decode", () => {
		expect(() => streamIdOfSubject("fleet.other.x")).toThrow(
			/not a journal subject/,
		);
		expect(() => streamIdOfSubject("fleet.journal.%E2")).toThrow(
			/does not decode/,
		);
	});

	it("orders positions by stream sequence, then by place in the batch", () => {
		expect(positionOf(1, 0) < positionOf(1, 1)).toBe(true);
		expect(positionOf(1, 1_000) < positionOf(2, 0)).toBe(true);
	});

	it("refuses a message that is not a batch of this stream", () => {
		const bytes = new TextEncoder().encode(
			'{"v":1,"ownerEpoch":"0","events":[{}]}',
		);
		expect(() => decodeBatch(bytes, "x")).toThrow();
		expect(() =>
			decodeBatch(new TextEncoder().encode("not json"), "x"),
		).toThrow();
		const encode = (text: string) => new TextEncoder().encode(text);
		expect(() =>
			decodeBatch(encode('{"v":2,"ownerEpoch":"0","events":[]}'), "x"),
		).toThrow(/version-1 batch/);
		expect(() =>
			decodeBatch(encode('{"v":1,"ownerEpoch":-1,"events":[]}'), "x"),
		).toThrow(/version-1 batch/);
		expect(() => decodeBatch(encode("[]"), "x")).toThrow(/version-1 batch/);
		const good = encodeBatch({ ownerEpoch: 0n, events: [] });
		expect(decodeBatch(good, "x").events).toEqual([]);
	});

	it("refuses a batch whose events name another stream", async () => {
		const stream = createFakeJournalStream();
		const store = openOn(stream);
		await store.append("one", [{ type: "fleet.Test", data: {} }], at(0));
		const [message] = stream.messages;
		if (message === undefined) throw new Error("no message");
		stream.messages.push({
			seq: 2,
			subject: "fleet.journal.two",
			data: message.data,
		});
		await expect(collect(store.read("two"))).rejects.toThrow(/another stream/);
	});
});

describe("compare-and-set across replicas", () => {
	it("refuses the second of two writers at the same expectedSeq, with the head it lost to", async () => {
		const stream = createFakeJournalStream();
		const first = openOn(stream);
		const second = openOn(stream);
		await first.append("s", [{ type: "fleet.Test", data: { n: 1 } }], at(0));
		const refused = second.append(
			"s",
			[{ type: "fleet.Test", data: { n: 2 } }],
			at(0),
		);
		await expect(refused).rejects.toBeInstanceOf(
			OptimisticSequenceConflictError,
		);
		await expect(refused).rejects.toMatchObject({ actualSeq: 1 });
		const appended = await second.append(
			"s",
			[{ type: "fleet.Test", data: { n: 3 } }],
			at(1),
		);
		expect(appended.appended.map((event) => event.seq)).toEqual([2]);
	});

	it("maps a lost race at the server to a sequence conflict and keeps the winner's events", async () => {
		const stream = createFakeJournalStream();
		const winner = openOn(stream);
		let raced = false;
		const loser = openJournalStore(
			createFakeJournalTransport(stream, {
				async beforePublish() {
					if (raced) return;
					raced = true;
					await winner.append("r", [{ type: "fleet.Won", data: {} }], at(0));
				},
			}),
		);
		await expect(
			loser.append("r", [{ type: "fleet.Lost", data: {} }], at(0)),
		).rejects.toBeInstanceOf(OptimisticSequenceConflictError);
		const held = await collect(loser.read("r"));
		expect(held.map((event) => event.type)).toEqual(["fleet.Won"]);
		expect(stream.publishes.map((entry) => entry.accepted)).toEqual([
			true,
			false,
		]);
	});

	it("deduplicates an idempotency key another replica committed, even at a stale expectedSeq", async () => {
		const stream = createFakeJournalStream();
		const first = openOn(stream);
		const keyed = {
			type: "fleet.Test",
			data: {},
			meta: { idempotencyKey: "k1" },
		};
		await first.append("d", [keyed], at(0));
		const reopened = openOn(stream);
		const again = await reopened.append("d", [keyed], at(0));
		expect(again.appended).toEqual([]);
		expect(again.deduped.map((event) => event.seq)).toEqual([1]);
	});

	it("appends a batch with one repeated key once and reports the repeat as deduped", async () => {
		const store = openOn(createFakeJournalStream());
		const keyed = {
			type: "fleet.Test",
			data: {},
			meta: { idempotencyKey: "k2" },
		};
		const result = await store.append("b", [keyed, keyed], at(0));
		expect(result.appended.map((event) => event.seq)).toEqual([1]);
		expect(result.deduped.map((event) => event.seq)).toEqual([1]);
	});

	it("returns positions for the appended events that readAll reports", async () => {
		const store = openOn(createFakeJournalStream());
		const result = await store.append(
			"p",
			[
				{ type: "fleet.Test", data: { n: 1 } },
				{ type: "fleet.Test", data: { n: 2 } },
			],
			at(0),
		);
		const all = await collect(store.readAll());
		expect(result.firstPosition).toBe(all[0]?.position);
		expect(result.lastPosition).toBe(all[1]?.position);
	});

	it("refuses a batch larger than a position can number", async () => {
		const stream = createFakeJournalStream();
		const store = openOn(stream);
		const event = { type: "fleet.Test", data: {} };
		await expect(
			store.append(
				"big",
				Array.from({ length: MAX_BATCH_EVENTS + 1 }, () => event),
				at(0),
			),
		).rejects.toBeInstanceOf(RangeError);
		expect(stream.messages).toEqual([]);
	});

	it("refuses bad input before writing anything", async () => {
		const stream = createFakeJournalStream();
		const store = openOn(stream);
		await expect(
			store.append("", [{ type: "fleet.Test", data: {} }], at(0)),
		).rejects.toThrow();
		await expect(
			store.append("x", [{ type: "fleet.Test", data: {} }], at(-1)),
		).rejects.toThrow();
		await expect(
			store.append("x", [{ type: "not a type", data: {} }], at(0)),
		).rejects.toThrow();
		expect(stream.messages).toEqual([]);
	});
});

describe("fencing", () => {
	it("keeps the highest owner epoch in the journal and refuses a stale or missing fence on any replica", async () => {
		const stream = createFakeJournalStream();
		const first = openOn(stream);
		await first.append(
			"f",
			[{ type: "fleet.Test", data: {} }],
			at(0, { fenceToken: 2n }),
		);
		const other = openOn(stream);
		await expect(
			other.append("f", [{ type: "fleet.Test", data: {} }], at(1)),
		).rejects.toBeInstanceOf(MissingFenceError);
		await expect(
			other.append(
				"f",
				[{ type: "fleet.Test", data: {} }],
				at(1, { fenceToken: 1n }),
			),
		).rejects.toBeInstanceOf(StaleFenceError);
		await other.append(
			"f",
			[{ type: "fleet.Test", data: {} }],
			at(1, { fenceToken: 3n }),
		);
		expect(other.getStreamHead("f")).toEqual({
			streamId: "f",
			revision: 2,
			ownerEpoch: 3n,
		});
	});
});

describe("snapshot and subscribe", () => {
	it("records a snapshot at or below the head and refuses one past it", async () => {
		const store = openOn(createFakeJournalStream());
		await store.append("n", [{ type: "fleet.Test", data: {} }], at(0));
		const record = await store.snapshot("n", { count: 1 }, 1);
		expect(record).toMatchObject({
			streamId: "n",
			seq: 1,
			state: { count: 1 },
		});
		await expect(store.snapshot("n", {}, 2)).rejects.toBeInstanceOf(
			OptimisticSequenceConflictError,
		);
	});

	it("delivers another replica's appends, filtered by type, in order", async () => {
		const stream = createFakeJournalStream();
		const reader = openOn(stream);
		const writer = openOn(stream);
		const seen: EventEnvelope[] = [];
		const subscription = reader.subscribe({ type: "fleet.Wanted" }, (event) => {
			seen.push(event);
		});
		await reader.append("w0", [{ type: "fleet.Other", data: {} }], at(0));
		await writer.append(
			"w1",
			[
				{ type: "fleet.Wanted", data: { n: 1 } },
				{ type: "fleet.Other", data: {} },
				{ type: "fleet.Wanted", data: { n: 2 } },
			],
			at(0),
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		subscription.unsubscribe();
		expect(seen.map((event) => event.data)).toEqual([{ n: 1 }, { n: 2 }]);
	});

	it("keeps delivering after a handler throws", async () => {
		const store = openOn(createFakeJournalStream());
		const seen: number[] = [];
		const subscription = store.subscribe({ streamId: "h" }, (event) => {
			seen.push(event.seq);
			if (event.seq === 1) throw new Error("handler failed");
		});
		await store.append("h", [{ type: "fleet.Test", data: {} }], at(0));
		await store.append("h", [{ type: "fleet.Test", data: {} }], at(1));
		await new Promise((resolve) => setTimeout(resolve, 20));
		subscription.unsubscribe();
		expect(seen).toEqual([1, 2]);
	});

	it("survives a subscription the transport could not start, and stops one never started", async () => {
		const stream = createFakeJournalStream();
		const transport = createFakeJournalTransport(stream);
		const store = openJournalStore({
			...transport,
			async watch() {
				throw new Error("no consumer rights");
			},
		});
		const subscription = store.subscribe({ streamId: "nw" }, () => undefined);
		await store.append("nw", [{ type: "fleet.Test", data: {} }], at(0));
		subscription.unsubscribe();
		const early = store.subscribe({ streamId: "nw" }, () => undefined);
		early.unsubscribe();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(stream.messages).toHaveLength(1);
	});

	it("reads nothing with readAll limit 0, and no head for a stream it never saw", async () => {
		const store = openOn(createFakeJournalStream());
		await store.append("z", [{ type: "fleet.Test", data: {} }], at(0));
		expect(await collect(store.readAll({ limit: 0 }))).toEqual([]);
		expect(store.getStreamHead("never")).toBeUndefined();
	});

	it("closes its transport", async () => {
		const transport = createFakeJournalTransport(createFakeJournalStream());
		const store = openJournalStore(transport);
		await store.close();
		expect(transport.closed()).toBe(true);
	});
});
