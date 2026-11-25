import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInMemoryActorHost, defineAggregate } from "@hobo/data";
import {
	createLocalStreamer,
	createManualClock,
	createRuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { describe, expect, it } from "vitest";

import { createReactor, defineMaterialization } from "../../src/index.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));

function loadPact(name: string) {
	return JSON.parse(readFileSync(join(packageRoot, "../pacts/", name), "utf8"));
}

function freshStore() {
	const dir = mkdtempSync(join(tmpdir(), "hobo-events-contract-"));
	return createRuntimeLocalEventStore({
		dataDir: dir,
		clock: createManualClock(),
	});
}

// SAFETY: the order.Placed read-set contract supplies orderId.
const ordersMaterialization = defineMaterialization<{ orderId: string }[]>({
	name: "ordersByTenant",
	readSet: ["order.Placed"],
	initialState: [],
	fold: (state, event) =>
		event.type === "order.Placed"
			? [...state, { orderId: (event.data as { orderId: string }).orderId }]
			: state,
});

const orders = defineAggregate<{ placed: boolean }, { id: string }>({
	name: "order",
	initialState: { placed: false },
	evolve: (s, e) => (e.type === "order.Placed" ? { placed: true } : s),
	decide: (_s, command, emitter) => {
		emitter.emit("order.Placed", { orderId: command.id });
	},
});

describe("@hobo/events subscription-gateway boundary consumer contract", () => {
	it("pushes a recomputed materialization at a monotonic seq", async () => {
		const store = freshStore();
		try {
			const pact = loadPact("subscription-gateway-boundary.pact.json");
			const interaction = pact.interactions[0];
			expect(pact.provider.name).toBe("SubscriptionGatewayBoundary");

			const reactor = createReactor({ store, streamer: createLocalStreamer() });
			const sub = await reactor.subscribe(ordersMaterialization, {
				subscriptionId: "sub:tenant-a-orders",
			});

			const result = await orders.execute(
				{ store, actorHost: createInMemoryActorHost() },
				"order:1001",
				{ id: "1001" },
				{ tenant: "tenant-a", actor: { kind: "user", id: "customer-1" } },
			);
			const observed = await sub.awaitSeq(result.seq);

			// The recorded push carries a per-stream seq and a result count.
			expect(observed.seq).toBe(interaction.request.body.seq["order:1001"]);
			expect(observed.value.length).toBe(interaction.request.body.resultCount);

			const pushed = sub
				.facts()
				.filter((f) => f.type === "subscription.Pushed")
				.at(-1);
			expect(pushed?.data.resultCount).toBe(
				interaction.request.body.resultCount,
			);
		} finally {
			store.close();
		}
	});
});
