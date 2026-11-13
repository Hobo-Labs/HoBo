/**
 * The journal import for a high-availability restore (L41): envelopes keep
 * their ids and their order, an import refuses a journal that holds anything
 * but a prefix of it (`conflict`), and a second run after a partial import
 * finishes it. Against the fake JetStream context.
 */
import type {
	AppendOptions,
	EventEnvelope,
	EventPosition,
	PositionedEvent,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import { importJournal } from "../../src/journal/import.js";
import { openJournalStore } from "../../src/journal/store.js";
import {
	createFakeJournalStream,
	createFakeJournalTransport,
	type FakeJournalStream,
} from "./fake-jetstream.js";

const at = (expectedSeq: number): AppendOptions => ({
	expectedSeq,
	actor: { kind: "service", id: "fleet-journal-import-test" },
	tenant: "t1",
});

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of items) out.push(item);
	return out;
}

/** A journal with three streams, batches of one and two events, interleaved. */
async function sourceJournal(): Promise<PositionedEvent[]> {
	const store = openJournalStore(
		createFakeJournalTransport(createFakeJournalStream()),
	);
	await store.append(
		"fleet-member-a",
		[
			{ type: "fleet.EnrollmentRequested", data: { n: 1 } },
			{ type: "fleet.MemberActivated", data: { n: 2 } },
		],
		at(0),
	);
	await store.append(
		"fleet-trust",
		[{ type: "fleet.TrustRotated", data: { sequence: 1 } }],
		at(0),
	);
	await store.append(
		"fleet-member-a",
		[{ type: "fleet.MemberSuspended", data: { n: 3 } }],
		at(2),
	);
	await store.append(
		"fleet member/b",
		[
			{ type: "fleet.EnrollmentRequested", data: { n: 1 } },
			{ type: "fleet.MemberActivated", data: { n: 2 } },
		],
		at(0),
	);
	return collect(store.readAll());
}

const readAllOf = (stream: FakeJournalStream) =>
	collect(openJournalStore(createFakeJournalTransport(stream)).readAll());

describe("importJournal", () => {
	it("round-trips readAll: same envelopes, ids, order and positions", async () => {
		const source = await sourceJournal();
		const target = createFakeJournalStream();
		const outcome = await importJournal(
			createFakeJournalTransport(target),
			source,
		);
		expect(outcome).toEqual({ ok: true, value: { imported: 6, present: 0 } });
		const restored = await readAllOf(target);
		expect(restored).toEqual(source);
		// One message per original batch.
		expect(target.messages).toHaveLength(4);
	});

	it("takes bare envelopes too, one message each, and keeps the readAll order", async () => {
		const source = await sourceJournal();
		const target = createFakeJournalStream();
		const envelopes: EventEnvelope[] = source.map((item) => item.event);
		const outcome = await importJournal(
			createFakeJournalTransport(target),
			envelopes.map((event) => ({ event })),
		);
		expect(outcome.ok).toBe(true);
		expect(target.messages).toHaveLength(6);
		const restored = await readAllOf(target);
		expect(restored.map((item) => item.event)).toEqual(envelopes);
	});

	it("lets the restored journal take the next append of each stream", async () => {
		const source = await sourceJournal();
		const target = createFakeJournalStream();
		await importJournal(createFakeJournalTransport(target), source);
		const store = openJournalStore(createFakeJournalTransport(target));
		const appended = await store.append(
			"fleet-member-a",
			[{ type: "fleet.MemberResumed", data: {} }],
			at(3),
		);
		expect(appended.appended[0]?.seq).toBe(4);
		expect(
			(await collect(store.read("fleet-member-a"))).map((event) => event.seq),
		).toEqual([1, 2, 3, 4]);
	});

	it("is idempotent: a second run after a partial import finishes it, and a third does nothing", async () => {
		const source = await sourceJournal();
		const target = createFakeJournalStream();
		let publishes = 0;
		const crashing = createFakeJournalTransport(target, {
			beforePublish: async () => {
				publishes += 1;
				if (publishes === 3) throw new Error("connection lost");
			},
		});
		await expect(importJournal(crashing, source)).rejects.toThrow(
			/connection lost/,
		);
		expect(target.messages).toHaveLength(2);

		const resumed = await importJournal(
			createFakeJournalTransport(target),
			source,
		);
		expect(resumed).toEqual({ ok: true, value: { imported: 3, present: 3 } });
		expect(await readAllOf(target)).toEqual(source);

		const again = await importJournal(
			createFakeJournalTransport(target),
			source,
		);
		expect(again).toEqual({ ok: true, value: { imported: 0, present: 6 } });
		expect(target.messages).toHaveLength(4);
	});

	it("refuses a journal that holds anything but a prefix of the import (conflict)", async () => {
		const source = await sourceJournal();
		const target = createFakeJournalStream();
		const other = openJournalStore(createFakeJournalTransport(target));
		await other.append(
			"fleet-member-a",
			[{ type: "fleet.EnrollmentRequested", data: { n: 1 } }],
			at(0),
		);
		const outcome = await importJournal(
			createFakeJournalTransport(target),
			source,
		);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.error.code).toBe("conflict");
		expect(target.messages).toHaveLength(1);

		// A journal longer than the import is not a prefix of it either.
		const longer = createFakeJournalStream();
		await importJournal(createFakeJournalTransport(longer), source);
		const short = await importJournal(
			createFakeJournalTransport(longer),
			source.slice(0, 3),
		);
		expect(short.ok).toBe(false);
		if (!short.ok) expect(short.error.code).toBe("conflict");
	});

	it("refuses, before writing anything, an import whose streams skip a sequence or repeat an id", async () => {
		const source = await sourceJournal();
		const skipping = source.filter((item) => item.event.seq !== 2);
		const target = createFakeJournalStream();
		const skipped = await importJournal(
			createFakeJournalTransport(target),
			skipping,
		);
		expect(skipped.ok).toBe(false);
		if (!skipped.ok) expect(skipped.error.code).toBe("invalid-request");

		const first = source[0];
		if (first === undefined) throw new Error("empty source");
		const repeated = [
			...source,
			{
				event: { ...first.event, seq: 4 },
				// SAFETY: a later position for the repeated envelope; positions are bigints.
				position: (first.position + 1_000_000_000n) as EventPosition,
			},
		];
		const duplicate = await importJournal(
			createFakeJournalTransport(target),
			repeated,
		);
		expect(duplicate.ok).toBe(false);
		if (!duplicate.ok) expect(duplicate.error.code).toBe("invalid-request");

		const malformed = await importJournal(createFakeJournalTransport(target), [
			{ event: { ...first.event, id: "" } },
		]);
		expect(malformed.ok).toBe(false);
		expect(target.messages).toHaveLength(0);
	});

	it("imports nothing into an empty journal from an empty archive", async () => {
		const target = createFakeJournalStream();
		expect(await importJournal(createFakeJournalTransport(target), [])).toEqual(
			{ ok: true, value: { imported: 0, present: 0 } },
		);
	});
});
