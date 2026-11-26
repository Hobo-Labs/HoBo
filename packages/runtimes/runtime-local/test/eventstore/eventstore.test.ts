import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	collectStream,
	createManualClock,
	createRuntimeLocalEventStore,
	OptimisticSequenceConflictError,
} from "../../src/index.js";
import { isJsonObject, isJsonString } from "../../src/json.js";

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function storeForTest() {
	const dataDir = tempDir("hobo-es-test-");
	const clock = createManualClock("2026-06-26T00:00:00.000Z");
	const store = createRuntimeLocalEventStore({ dataDir, clock });
	return { store, dataDir, clock };
}

describe("runtime-local EventStore", () => {
	it("appends, reads, subscribes, and snapshots one stream", async () => {
		const { store } = storeForTest();
		const pushed: unknown[] = [];
		const subscription = store.subscribe(
			{ streamId: "run:checkout-1" },
			(event) => {
				pushed.push(event);
			},
		);

		const appended = await store.append(
			"run:checkout-1",
			[{ type: "run.Started", data: { workflow: "checkout" } }],
			{
				expectedSeq: 0,
				actor: { kind: "system", id: "runtime-local" },
				tenant: "tenant-a",
				correlationId: "run-1",
			},
		);

		expect(appended.appended).toHaveLength(1);
		expect(await collectStream(store, "run:checkout-1")).toEqual([
			{
				id: appended.appended[0]?.id,
				streamId: "run:checkout-1",
				seq: 1,
				type: "run.Started",
				v: 1,
				ts: "2026-06-26T00:00:00.000Z",
				actor: { kind: "system", id: "runtime-local" },
				tenant: "tenant-a",
				causationId: undefined,
				correlationId: "run-1",
				data: { workflow: "checkout" },
				meta: {},
			},
		]);
		// SAFETY: assertion to `event as { seq: number }` is required at this boundary.
		expect(pushed.map((event) => (event as { seq: number }).seq)).toEqual([1]);

		const snapshot = await store.snapshot(
			"run:checkout-1",
			{ status: "started" },
			1,
		);
		expect(snapshot).toEqual({
			streamId: "run:checkout-1",
			seq: 1,
			state: { status: "started" },
			savedAt: "2026-06-26T00:00:00.000Z",
		});

		subscription.unsubscribe();
		store.close();
	});

	it("rejects stale concurrent writers without losing the first event", async () => {
		const { store } = storeForTest();
		const options = appendOptions();

		await store.append(
			"order:1",
			[{ type: "order.Created", data: { total: 25 } }],
			{
				...options,
				expectedSeq: 0,
			},
		);

		await expect(
			store.append(
				"order:1",
				[{ type: "order.Discounted", data: { amount: 5 } }],
				{
					...options,
					expectedSeq: 0,
				},
			),
		).rejects.toBeInstanceOf(OptimisticSequenceConflictError);

		expect(
			(await collectStream(store, "order:1")).map((event) => [
				event.seq,
				event.type,
			]),
		).toEqual([[1, "order.Created"]]);
		store.close();
	});

	it("dedups idempotency keys per stream", async () => {
		const { store } = storeForTest();
		const first = await store.append(
			"invoice:1",
			[invoiceCharged("charge-123", 100)],
			{
				...appendOptions(),
				expectedSeq: 0,
			},
		);
		const retry = await store.append(
			"invoice:1",
			[invoiceCharged("charge-123", 100)],
			{
				...appendOptions(),
				expectedSeq: 0,
			},
		);
		const otherStream = await store.append(
			"invoice:2",
			[invoiceCharged("charge-123", 100)],
			{
				...appendOptions(),
				expectedSeq: 0,
			},
		);

		expect(first.appended).toHaveLength(1);
		expect(retry.appended).toHaveLength(0);
		expect(retry.deduped.map((event) => event.id)).toEqual([
			first.appended[0]?.id,
		]);
		expect(
			(await collectStream(store, "invoice:1")).map((event) => event.seq),
		).toEqual([1]);
		expect(otherStream.appended.map((event) => event.id)).toEqual([
			expect.stringMatching(/^[\dA-Z]{26}$/),
		]);
		store.close();
	});

	it("collapses duplicate idempotency keys inside one append batch", async () => {
		const { store } = storeForTest();
		const result = await store.append(
			"invoice:batch-1",
			[invoiceCharged("charge-456", 100), invoiceCharged("charge-456", 100)],
			{ ...appendOptions(), expectedSeq: 0 },
		);

		expect(result.appended.map((event) => event.seq)).toEqual([1]);
		expect(result.deduped.map((event) => event.seq)).toEqual([1]);
		expect(
			(await collectStream(store, "invoice:batch-1")).map((event) => event.seq),
		).toEqual([1]);
		store.close();
	});

	it("quarantines poison events and continues folds deterministically", async () => {
		const { store } = storeForTest();
		await store.append(
			"ticket:1",
			[
				{ type: "ticket.Opened", data: { title: "Login" } },
				{ type: "ticket.Commented", data: { text: "first" } },
				{ type: "ticket.Opened", data: { status: "missing-title" } },
				{ type: "ticket.Commented", data: { text: "second" } },
			],
			{ ...appendOptions(), expectedSeq: 0 },
		);

		const folded = await store.fold("ticket:1", {
			initialState: { comments: 0, title: "" },
			handlers: {
				"ticket.Opened": (state, event) => {
					const data = event.data;
					if (!isJsonObject(data) || !isJsonString(data.title)) {
						throw new Error("ticket.Opened requires title");
					}
					return { ...state, title: data.title };
				},
				"ticket.Commented": (state) => ({
					...state,
					comments: state.comments + 1,
				}),
			},
		});

		expect(folded.state).toEqual({ comments: 2, title: "Login" });
		expect(folded.quarantined).toHaveLength(1);
		expect(folded.quarantined[0]?.offendingSeq).toBe(3);
		expect(
			(await collectStream(store, "ticket:1")).map((event) => [
				event.seq,
				event.type,
				// SAFETY: assertion to `event.data as { offendingSeq?: number }` is required at this boundary.
				(event.data as { offendingSeq?: number }).offendingSeq,
			]),
		).toEqual([
			[1, "ticket.Opened", undefined],
			[2, "ticket.Commented", undefined],
			[3, "ticket.Opened", undefined],
			[4, "ticket.Commented", undefined],
			[5, "ticket.Quarantined", 3],
		]);
		store.close();
	});
});

function appendOptions() {
	return {
		actor: { kind: "system" as const, id: "runtime-local" },
		tenant: "tenant-a",
	};
}

function invoiceCharged(idempotencyKey: string, amount: number) {
	return {
		type: "invoice.Charged",
		data: { amount },
		meta: { idempotencyKey },
	};
}
