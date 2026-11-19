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

		let live = orderView.fold(events.slice(0, 1));
		for (let i = 2; i <= events.length; i += 1) {
			live = orderView.fold(events.slice(0, i));
		}

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
					const data = event.data as Inspectable;
					if (!isJsonObject(data)) {
						throw new TypeError("order event data must be an object");
					}
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

	it("carries immutable read-model metadata through declaration and snapshots", async () => {
		const statusField = { name: "status", type: "string" };
		const schema = {
			witRecord: "shop:orders/order-view@1.0.0",
			fields: [statusField, { name: "orderId", type: "string" }],
		};
		const hints = ["status", "orderId", "status"];
		const projection = defineProjection<OrderRow>({
			name: "orders-with-metadata",
			readModel: schema.witRecord,
			rowSchema: schema,
			indexHints: hints,
			key: (event) => parseOrderId(event.data),
			on: {
				"order.Placed": (_row, event) => ({
					orderId: parseOrderId(event.data),
					status: "placed",
					totalCents: parseOrderPlacedData(event.data).totalCents,
				}),
			},
		});
		statusField.type = "changed";
		hints.push("changed");
		const expected = {
			readModel: "shop:orders/order-view@1.0.0",
			rowSchema: {
				witRecord: "shop:orders/order-view@1.0.0",
				fields: [
					{ name: "orderId", type: "string" },
					{ name: "status", type: "string" },
				],
			},
			indexHints: ["orderId", "status"],
		};
		expect(projection.declared().data).toMatchObject(expected);
		const s = store();
		await seedFixture(s);
		const snapshot = await projection.rebuildFromZero(s, "order:1001");
		const expectedSnapshot = {
			...expected,
			readSet: ["order.Placed"],
			reactivityClass: "reactive",
		};
		expect(snapshot).toMatchObject(expectedSnapshot);
		expect(projection.snapshot(snapshot)).toMatchObject(expectedSnapshot);
	});

	it("rejects inconsistent or ambiguous read-model metadata", () => {
		const base = {
			name: "invalid-metadata",
			key: (event: EventEnvelope) => event.streamId,
			on: { "order.Placed": () => ({}) },
		};
		expect(() =>
			defineProjection({ ...base, readModel: "shop:orders/view@1.0.0" }),
		).toThrow(/row schema/i);
		expect(() =>
			defineProjection({
				...base,
				rowSchema: {
					witRecord: "shop:orders/view@1.0.0",
					fields: [
						{ name: "id", type: "string" },
						{ name: "id", type: "u32" },
					],
				},
			}),
		).toThrow(/duplicate/i);
	});
});
