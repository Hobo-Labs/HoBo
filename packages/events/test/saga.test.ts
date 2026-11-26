import type { EventEnvelope } from "@hobo/core";
import {
	AggregateInvariantError,
	createInMemoryActorHost,
	defineAggregate,
	defineProjection,
} from "@hobo/data";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import { defineSaga } from "../src/index.js";
import { CTX, freshStore } from "./helpers.js";

// --- Two aggregates: order and payment (the cross-aggregate boundary) ---------

interface OrderState {
	status: "none" | "placed" | "cancelled";
	totalCents: number;
}

// SAFETY: event.type selects the order.Placed payload shape supplied by the aggregate contract.
const orders = defineAggregate<
	OrderState,
	{ kind: "place" | "cancel"; id: string; totalCents?: number }
>({
	name: "order",
	initialState: { status: "none", totalCents: 0 },
	evolve: (state, event) => {
		if (event.type === "order.Placed")
			return {
				status: "placed",
				// SAFETY: order.Placed carries the declared totalCents payload.
				totalCents: (event.data as { totalCents: number }).totalCents,
			};
		if (event.type === "order.Cancelled")
			return { ...state, status: "cancelled" };
		return state;
	},
	decide: (state, command, emitter) => {
		if (command.kind === "place") {
			if (state.status === "placed")
				throw new AggregateInvariantError("order already placed");
			emitter.emit("order.Placed", {
				orderId: command.id,
				totalCents: command.totalCents ?? 0,
			});
		} else {
			if (state.status !== "placed")
				throw new AggregateInvariantError("cannot cancel a non-placed order");
			emitter.emit("order.Cancelled", { orderId: command.id });
		}
	},
});

const CHARGE_LIMIT = 5000;

const payments = defineAggregate<
	{ charged: boolean },
	{ orderId: string; amountCents: number }
>({
	name: "payment",
	initialState: { charged: false },
	evolve: (state, event) =>
		event.type === "payment.Charged" ? { charged: true } : state,
	decide: (_state, command, emitter) => {
		// Seeded failure: a charge over the limit is declined (an invariant error).
		if (command.amountCents > CHARGE_LIMIT)
			throw new AggregateInvariantError("payment declined: over limit");
		emitter.emit("payment.Charged", {
			orderId: command.orderId,
			amountCents: command.amountCents,
		});
	},
});

// A projection to prove the flow round-trips into a queryable read model.
// SAFETY: projection event keys select the declared payload shapes.
const orderView = defineProjection<{ orderId: string; status: string }>({
	name: "orders",
	key: (e) => (e.data as { orderId: string }).orderId,
	on: {
		"order.Placed": (_r, e) => ({
			orderId: (e.data as { orderId: string }).orderId,
			status: "placed",
		}),
		"order.Cancelled": (r, _e) => ({
			...(r as { orderId: string }),
			status: "cancelled",
		}),
	},
});

// --- The saga: on order.Placed -> charge payment; compensate by cancelling ----

// SAFETY: the saga trigger contract supplies orderId and totalCents on order.Placed.
const checkout = defineSaga({
	name: "checkout",
	trigger: "order.Placed",
	step: async (event, ctx) => {
		// SAFETY: order.Placed carries the declared orderId payload.
		const orderId = (event.data as { orderId: string }).orderId;
		// SAFETY: order.Placed carries the declared totalCents payload.
		const totalCents = (event.data as { totalCents: number }).totalCents;
		await ctx.dispatch(
			"charge-payment",
			payments,
			`payment:${orderId}`,
			{
				orderId,
				amountCents: totalCents,
			},
			CTX,
		);
	},
	compensate: async (event, ctx) => {
		// SAFETY: order.Placed carries the declared orderId payload.
		const orderId = (event.data as { orderId: string }).orderId;
		await ctx.dispatch(
			"cancel-order",
			orders,
			`order:${orderId}`,
			{
				kind: "cancel",
				id: orderId,
			},
			CTX,
		);
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

async function placeOrder(
	_s: RuntimeLocalEventStore,
	deps: {
		store: RuntimeLocalEventStore;
		actorHost: ReturnType<typeof createInMemoryActorHost>;
	},
	id: string,
	totalCents: number,
): Promise<EventEnvelope> {
	const result = await orders.execute(
		deps,
		`order:${id}`,
		{ kind: "place", id, totalCents },
		CTX,
	);
	// SAFETY: placing an order appends exactly one EventEnvelope for this test aggregate.
	return result.appended[0] as EventEnvelope;
}

describe("cross-aggregate checkout saga", () => {
	it("completes: order.Placed drives a payment charge across aggregates", async () => {
		const s = store();
		const deps = { store: s, actorHost: createInMemoryActorHost() };
		const trigger = await placeOrder(s, deps, "1001", 4200);

		const outcome = await checkout.run(trigger, deps);

		expect(outcome.status).toBe("completed");
		const factTypes = outcome.facts.map((f) => f.type);
		expect(factTypes).toEqual([
			"saga.Started",
			"saga.StepEmitted",
			"saga.Completed",
		]);
		expect(outcome.facts[1]?.data).toMatchObject({
			step: "charge-payment",
			emittedType: "payment.Charged",
		});

		const payment = await payments.load(s, "payment:1001");
		expect(payment.state.charged).toBe(true);
	});

	it("compensates on a seeded failure: an over-limit charge cancels the order", async () => {
		const s = store();
		const deps = { store: s, actorHost: createInMemoryActorHost() };
		const trigger = await placeOrder(s, deps, "2002", 9000);

		const outcome = await checkout.run(trigger, deps);

		expect(outcome.status).toBe("compensated");
		const factTypes = outcome.facts.map((f) => f.type);
		expect(factTypes).toContain("saga.Compensated");
		expect(factTypes).toContain("saga.StepEmitted"); // the compensating cancel
		const compensated = outcome.facts.find(
			(f) => f.type === "saga.Compensated",
		);
		expect(compensated?.data).toMatchObject({
			step: "charge-payment",
			reason: "payment declined: over limit",
		});

		// Payment never charged; the order was rolled back via compensation.
		const payment = await payments.load(s, "payment:2002");
		expect(payment.state.charged).toBe(false);

		const view = await orderView.rebuildFromZero(s, "order:2002");
		expect(orderView.get(view, "2002")?.status).toBe("cancelled");
	});
});
