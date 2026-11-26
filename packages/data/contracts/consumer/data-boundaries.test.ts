import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createManualClock,
	createRuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { describe, expect, it } from "vitest";

import {
	createInMemoryActorHost,
	defineAggregate,
	defineProjection,
} from "../../src/index.js";
import { parseOrderId, parseOrderPlacedData } from "../../test/helpers.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));

function loadPact(name: string) {
	return JSON.parse(readFileSync(join(packageRoot, "../pacts/", name), "utf8"));
}

function freshStore() {
	const dir = mkdtempSync(join(tmpdir(), "hobo-data-contract-"));
	return createRuntimeLocalEventStore({
		dataDir: dir,
		clock: createManualClock(),
	});
}

interface OrderState {
	placed: boolean;
	totalCents: number;
}

const orders = defineAggregate<OrderState, { id: string; totalCents: number }>({
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
		if (state.placed) throw new Error("order already placed");
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

describe("@hobo/data event-store append boundary consumer contract", () => {
	it("appends the aggregate's fact at the recorded seq", async () => {
		const store = freshStore();
		try {
			const pact = loadPact("eventstore-append-boundary.pact.json");
			const interaction = pact.interactions[0];
			expect(pact.provider.name).toBe("EventStoreAppendBoundary");

			const result = await orders.execute(
				{ store, actorHost: createInMemoryActorHost() },
				"order:1001",
				{ id: "1001", totalCents: 4200 },
				{ tenant: "tenant-a", actor: { kind: "user", id: "customer-1" } },
			);

			expect(result.appended[0]?.type).toBe(interaction.request.body.type);
			expect({ streamId: result.streamId, seq: result.seq }).toEqual(
				interaction.response.body,
			);
		} finally {
			store.close();
		}
	});
});

describe("@hobo/data projection-sink boundary consumer contract", () => {
	it("materializes the order row the sink boundary upserts", async () => {
		const store = freshStore();
		try {
			const pact = loadPact("projection-sink-boundary.pact.json");
			const interaction = pact.interactions[0];
			expect(pact.provider.name).toBe("ProjectionSinkBoundary");

			await orders.execute(
				{ store, actorHost: createInMemoryActorHost() },
				"order:1001",
				{ id: "1001", totalCents: 4200 },
				{ tenant: "tenant-a", actor: { kind: "user", id: "customer-1" } },
			);

			const snapshot = await orderView.rebuildFromZero(store, "order:1001");
			const row = orderView.get(snapshot, "1001");
			expect(row?.totalCents).toBe(interaction.request.body.totalCents);
			expect(snapshot.seq).toBe(
				interaction.response.body.sourceSeq["order:1001"],
			);
		} finally {
			store.close();
		}
	});
});
