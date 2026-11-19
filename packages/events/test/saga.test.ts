import type { EventEnvelope } from "@hobo/core";
import {
	AggregateInvariantError,
	createInMemoryActorHost,
	defineAggregate,
	defineProjection,
} from "@hobo/data";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineSaga } from "../src/saga.js";
import { CTX, freshStore } from "./helpers.js";

interface OrderState {
	status: "none" | "placed" | "cancelled";
	totalCents: number;
}

const orderIdSchema = z.object({ orderId: z.string() });
const orderTotalSchema = z.object({ totalCents: z.number() });

const orderIdOf = (event: EventEnvelope) =>
	orderIdSchema.parse(event.data).orderId;
const totalCentsOf = (event: EventEnvelope) =>
	orderTotalSchema.parse(event.data).totalCents;

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
				totalCents: totalCentsOf(event),
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
		if (command.amountCents > CHARGE_LIMIT)
			throw new AggregateInvariantError("payment declined: over limit");
		emitter.emit("payment.Charged", {
			orderId: command.orderId,
			amountCents: command.amountCents,
		});
	},
});

const orderView = defineProjection<{ orderId: string; status: string }>({
	name: "orders",
	key: orderIdOf,
	on: {
		"order.Placed": (_r, e) => ({
			orderId: orderIdOf(e),
			status: "placed",
		}),
		"order.Cancelled": (_r, e) => ({
			orderId: orderIdOf(e),
			status: "cancelled",
		}),
	},
});

const checkout = defineSaga({
	name: "checkout",
	trigger: "order.Placed",
	step: async (event, ctx) => {
		const orderId = orderIdOf(event);
		const totalCents = totalCentsOf(event);
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
		const orderId = orderIdOf(event);
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
function createStore(): RuntimeLocalEventStore {
	const eventStore = freshStore();
	stores.push(eventStore);
	return eventStore;
}
afterEach(() => {
	for (const eventStore of stores) eventStore.close();
	stores = [];
});

async function placeOrder(
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
	const placed = result.appended[0];
	if (placed === undefined) throw new Error("order was not placed");
	return placed;
}

describe("cross-aggregate checkout saga", () => {
	it("completes: order.Placed drives a payment charge across aggregates", async () => {
		const eventStore = createStore();
		const deps = { store: eventStore, actorHost: createInMemoryActorHost() };
		const trigger = await placeOrder(deps, "1001", 4200);

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

		const payment = await payments.load(eventStore, "payment:1001");
		expect(payment.state.charged).toBe(true);
	});

	it("compensates on a seeded failure: an over-limit charge cancels the order", async () => {
		const eventStore = createStore();
		const deps = { store: eventStore, actorHost: createInMemoryActorHost() };
		const trigger = await placeOrder(deps, "2002", 9000);

		const outcome = await checkout.run(trigger, deps);

		expect(outcome.status).toBe("compensated");
		const factTypes = outcome.facts.map((f) => f.type);
		expect(factTypes).toEqual([
			"saga.Started",
			"saga.StepEmitted",
			"saga.Compensated",
			"saga.Completed",
		]);
		expect(outcome.facts[1]?.data).toMatchObject({
			step: "cancel-order",
			emittedType: "order.Cancelled",
		});
		const compensated = outcome.facts.find(
			(f) => f.type === "saga.Compensated",
		);
		expect(compensated?.data).toMatchObject({
			step: "charge-payment",
			reason: "payment declined: over limit",
		});

		const payment = await payments.load(eventStore, "payment:2002");
		expect(payment.state.charged).toBe(false);

		const view = await orderView.rebuildFromZero(eventStore, "order:2002");
		expect(orderView.get(view, "2002")?.status).toBe("cancelled");
	});
});
