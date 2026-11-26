import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import {
	AggregateConflictError,
	AggregateInvariantError,
	createInMemoryActorHost,
	defineAggregate,
	defineProjection,
} from "../src/index.js";
import {
	freshStore,
	type OrderCommand,
	type OrderState,
	parseOrderId,
	parseOrderPlacedData,
} from "./helpers.js";

const orders = defineAggregate<OrderState, OrderCommand>({
	name: "order",
	initialState: { placed: false, totalCents: 0 },
	evolve: (state, event) =>
		event.type === "order.Placed"
			? {
					placed: true,
					totalCents: parseOrderPlacedData(event.data).totalCents,
				}
			: state,
	decide: (state, command, emitter) => {
		if (state.placed) throw new AggregateInvariantError("order already placed");
		emitter.emit("order.Placed", {
			orderId: command.id,
			totalCents: command.totalCents,
		});
	},
});

const orderView = defineProjection<{ orderId: string; totalCents: number }>({
	name: "orders",
	key: (event) => parseOrderId(event.data),
	on: {
		"order.Placed": (_row, event) => parseOrderPlacedData(event.data),
	},
});

const ctx = {
	tenant: "tenant-a",
	actor: { kind: "user", id: "customer-1" } as const,
};

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

describe("defineAggregate write-model fold", () => {
	it("round-trips a command to a queryable projection", async () => {
		const s = store();
		const actorHost = createInMemoryActorHost();

		const result = await orders.execute(
			{ store: s, actorHost },
			"order:1001",
			{ id: "1001", totalCents: 4200 },
			ctx,
		);

		expect(result.seq).toBe(1);
		expect(result.state).toEqual({ placed: true, totalCents: 4200 });
		expect(result.appended.map((e) => e.type)).toEqual(["order.Placed"]);

		const view = await orderView.rebuildFromZero(s, "order:1001");
		expect(orderView.query(view)).toEqual([
			{ orderId: "1001", totalCents: 4200 },
		]);
	});

	it("emits actor.* lifecycle facts (Activated/StateAppended/Passivated)", async () => {
		const s = store();
		const result = await orders.execute(
			{ store: s, actorHost: createInMemoryActorHost() },
			"order:1002",
			{ id: "1002", totalCents: 10 },
			ctx,
		);
		expect(result.lifecycle.map((f) => f.type)).toEqual([
			"actor.Activated",
			"actor.StateAppended",
			"actor.Passivated",
		]);
		expect(result.fenceToken).toBe(1n);
	});

	it("throws a non-retryable invariant error when the command is illegal", async () => {
		const s = store();
		const actorHost = createInMemoryActorHost();
		const deps = { store: s, actorHost };
		await orders.execute(
			deps,
			"order:1003",
			{ id: "1003", totalCents: 1 },
			ctx,
		);

		await expect(
			orders.execute(deps, "order:1003", { id: "1003", totalCents: 2 }, ctx),
		).rejects.toMatchObject({
			name: "AggregateInvariantError",
			retryable: false,
		});
	});

	it("throws the typed retryable conflict error on an optimistic seq collision", async () => {
		const s = store();
		// Seed the real stream so its current length is 1.
		await s.append(
			"order:1004",
			[{ type: "order.Placed", data: { orderId: "1004", totalCents: 1 } }],
			{ expectedSeq: 0, actor: ctx.actor, tenant: ctx.tenant },
		);

		// Wrap the real store so the aggregate FOLDS an empty view (expectedSeq 0)
		// while the underlying append still targets the real stream at seq 1 — a
		// genuine optimistic collision the real EventStore rejects.
		const staleStore = {
			...s,
			read() {
				return (async function* () {})();
			},
			append: s.append.bind(s),
		};

		await expect(
			orders.execute(
				{ store: staleStore, actorHost: createInMemoryActorHost() },
				"order:1004",
				{ id: "1004", totalCents: 9 },
				ctx,
			),
		).rejects.toBeInstanceOf(AggregateConflictError);
	});
});
