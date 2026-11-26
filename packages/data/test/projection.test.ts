import type { EventEnvelope } from "@hobo/core";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import { defineProjection } from "../src/index.js";
import { type Inspectable, isJsonObject } from "../src/json.js";
import {
	freshStore,
	type OrderRow,
	parseOrderId,
	parseOrderPlacedData,
} from "./helpers.js";

const orderView = defineProjection<OrderRow>({
	name: "orders",
	key: (event) => parseOrderId(event.data),
	on: {
		"order.Placed": (_row, event) => {
			const placed = parseOrderPlacedData(event.data);
			return {
				orderId: placed.orderId,
				status: "placed",
				totalCents: placed.totalCents,
			};
		},
		"order.Confirmed": (row, _event) => {
			if (row === undefined) {
				throw new TypeError("order.Confirmed requires an existing row");
			}
			return {
				...row,
				status: "confirmed",
			};
		},
	},
});

const actor = { kind: "user", id: "u1" } as const;

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

async function seedFixture(s: RuntimeLocalEventStore): Promise<void> {
	await s.append(
		"order:1001",
		[
			{ type: "order.Placed", data: { orderId: "1001", totalCents: 4200 } },
			{ type: "order.Confirmed", data: { orderId: "1001" } },
		],
		{ expectedSeq: 0, actor, tenant: "tenant-a" },
	);
	await s.append(
		"order:1001",
		[{ type: "order.Placed", data: { orderId: "1002", totalCents: 999 } }],
		{ expectedSeq: 2, actor, tenant: "tenant-a" },
	);
}

describe("defineProjection read-model fold", () => {
	it("rebuildFromZero equals the live fold byte-for-byte on a fixture stream", async () => {
		const s = store();
		await seedFixture(s);

		const events: EventEnvelope[] = [];
		for await (const event of s.read("order:1001")) events.push(event);

		// "live": fold each growing prefix as events would arrive on the wire.
		let live = orderView.fold(events.slice(0, 1));
		for (let i = 2; i <= events.length; i += 1) {
			live = orderView.fold(events.slice(0, i));
		}

		// "rebuild": drop the sink, replay the whole stream from the log.
		const rebuilt = await orderView.rebuildFromZero(s, "order:1001");

		expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(live));
		expect(rebuilt.seq).toBe(3);
		expect(orderView.get(rebuilt, "1001")).toEqual({
			orderId: "1001",
			status: "confirmed",
			totalCents: 4200,
		});
	});

	it("cannot mutate the write model — the fold is read-only by construction", async () => {
		const s = store();
		await seedFixture(s);

		let sawFrozenEvent = false;
		const spyView = defineProjection<OrderRow>({
			name: "orders-spy",
			key: (event) => parseOrderId(event.data),
			on: {
				"order.Placed": (_row, event) => {
					sawFrozenEvent = Object.isFrozen(event);
					// SAFETY: EventEnvelope.data is JSON at the store boundary.
					const data = event.data as Inspectable;
					if (!isJsonObject(data)) {
						throw new TypeError("order event data must be an object");
					}
					// A write attempt against the event body must throw (frozen input).
					expect(() => {
						Object.assign(data, { totalCents: -1 });
					}).toThrow();
					const placed = parseOrderPlacedData(event.data);
					return {
						orderId: placed.orderId,
						status: "placed",
						totalCents: placed.totalCents,
					};
				},
			},
		});

		await spyView.rebuildFromZero(s, "order:1001");
		expect(sawFrozenEvent).toBe(true);

		// The projection surface exposes no write/append/emit capability.
		expect("emit" in spyView).toBe(false);
		expect("append" in spyView).toBe(false);
		expect("store" in spyView).toBe(false);
	});

	it("declares its read-set and reactivity class as a projection.Declared fact", () => {
		const declared = orderView.declared();
		expect(declared.type).toBe("projection.Declared");
		expect(declared.data).toMatchObject({
			projection: "orders",
			readSet: ["order.Placed", "order.Confirmed"],
			reactivityClass: "reactive",
		});
	});
});
