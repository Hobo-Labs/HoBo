import { createInMemoryActorHost, defineAggregate } from "@hobo/data";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { createLocalStreamer } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import { createReactor, defineMaterialization } from "../src/index.js";
import { CTX, freshStore } from "./helpers.js";

interface OrderRow {
	orderId: string;
	totalCents: number;
}

// SAFETY: the order.Placed read-set contract supplies orderId and totalCents.
const openOrders = defineMaterialization<OrderRow[]>({
	name: "openOrders",
	readSet: ["order.Placed"],
	initialState: [],
	fold: (state, event) =>
		event.type === "order.Placed"
			? [
					...state,
					{
						orderId: (event.data as { orderId: string }).orderId,
						totalCents: (event.data as { totalCents: number }).totalCents,
					},
				]
			: state,
});

const orders = defineAggregate<
	{ placed: boolean },
	{ id: string; totalCents: number }
>({
	name: "order",
	initialState: { placed: false },
	evolve: (state, event) =>
		event.type === "order.Placed" ? { placed: true } : state,
	decide: (state, command, emitter) => {
		if (state.placed) throw new Error("already placed");
		emitter.emit("order.Placed", {
			orderId: command.id,
			totalCents: command.totalCents,
		});
	},
});

let stores: RuntimeLocalEventStore[] = [];
function store(): RuntimeLocalEventStore {
	const s = freshStore();
	stores.push(s);
	return s;
}
afterEach(() => {
	for (const s of stores) s.close();
	stores = [];
});

describe("reactor reads-your-writes", () => {
	it("observes a just-appended event at >= its command seq", async () => {
		const s = store();
		const streamer = createLocalStreamer();
		const reactor = createReactor({ store: s, streamer });
		const deps = { store: s, actorHost: createInMemoryActorHost() };

		const sub = await reactor.subscribe(openOrders, {
			subscriptionId: "sub:orders-tenant-a",
		});
		expect(sub.current()).toEqual({ value: [], seq: 0 });

		// A command returns its seq; the subscription must advance to >= that seq.
		const result = await orders.execute(
			deps,
			"order:1001",
			{ id: "1001", totalCents: 4200 },
			CTX,
		);

		const observed = await sub.awaitSeq(result.seq);
		expect(observed.seq).toBeGreaterThanOrEqual(result.seq);
		expect(observed.value).toEqual([{ orderId: "1001", totalCents: 4200 }]);

		// Pushed over the Streamer port and recorded as subscription.* facts.
		const factTypes = sub.facts().map((f) => f.type);
		expect(factTypes).toContain("subscription.Opened");
		expect(factTypes).toContain("subscription.Recomputed");
		expect(factTypes).toContain("subscription.Pushed");
	});

	it("advances monotonically and never regresses across appends", async () => {
		const s = store();
		const streamer = createLocalStreamer();
		const reactor = createReactor({ store: s, streamer });
		const deps = { store: s, actorHost: createInMemoryActorHost() };

		const sub = await reactor.subscribe(openOrders, {
			subscriptionId: "sub:orders-mono",
		});

		const first = await orders.execute(
			deps,
			"order:2001",
			{ id: "2001", totalCents: 100 },
			CTX,
		);
		await sub.awaitSeq(first.seq);
		const afterFirst = sub.current().seq;

		const second = await orders.execute(
			deps,
			"order:2002",
			{ id: "2002", totalCents: 200 },
			CTX,
		);
		await sub.awaitSeq(second.seq);
		const afterSecond = sub.current().seq;

		expect(afterSecond).toBeGreaterThanOrEqual(afterFirst);
		expect(sub.current().value).toHaveLength(2);
	});

	it("replay-then-live: a new subscriber gets the current value before any live push", async () => {
		const s = store();
		// Seed the stream before subscribing.
		await s.append(
			"order:3001",
			[{ type: "order.Placed", data: { orderId: "3001", totalCents: 55 } }],
			{ expectedSeq: 0, actor: CTX.actor, tenant: CTX.tenant },
		);

		const streamer = createLocalStreamer();
		const reactor = createReactor({ store: s, streamer });
		const sub = await reactor.subscribe(openOrders, {
			subscriptionId: "sub:orders-replay",
			replayStreamId: "order:3001",
		});

		const current = sub.current();
		expect(current.seq).toBe(1);
		expect(current.value).toEqual([{ orderId: "3001", totalCents: 55 }]);
	});
});
