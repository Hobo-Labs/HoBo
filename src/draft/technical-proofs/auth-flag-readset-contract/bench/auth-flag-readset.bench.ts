import { bench, describe } from "vitest";

import { createAuthFlagReadsetReactor, defineMaterialization } from "../src/auth-flag-readset.ts";
import { type JsonObject } from "../src/json.js";


const event = (streamId: string, seq: number, type: string, data: JsonObject) => ({
	streamId,
	seq,
	type,
	data,
});

const visibleOrders = () =>
	defineMaterialization({
		name: "visibleOrders",
		readSet: [
			{ kind: "eventType", value: "order.Visible" },
			{ kind: "authState", value: "session" },
		],
		initialState: [],
		fold(state: Array<{ id: string; value: number }>, e: any, context: any) {
			if (e.type !== "order.Visible" || e.data.owner !== context.principal.id) return state;
			return [...state, { id: e.data.orderId, value: e.data.value }];
		},
	});

const orderEvents = Array.from({ length: 200 }, (_, index) =>
	event("orders", index + 1, "order.Visible", {
		orderId: `order-${index}`,
		owner: "user:alice",
		value: index,
	}),
);

// Numbers are advisory; the gate only requires that declared benches EXECUTE.
describe("auth/flag read-set reactor hot path", () => {
	bench("subscribe + recompute over a 200-event stream", () => {
		const reactor = createAuthFlagReadsetReactor({
			materializations: [visibleOrders()],
			sessions: [
				event("session:alice", 1, "session.Started", {
					sessionId: "session-alice",
					principalId: "user:alice",
				}),
			],
			events: orderEvents,
		});
		reactor.subscribe({
			subscriptionId: "sub:alice-orders",
			materialization: "visibleOrders",
			principal: { id: "user:alice", sessionId: "session-alice" },
			client: { push: () => {} },
		});
	});

	bench("append session.Revoked -> wake + recompute + push", () => {
		const reactor = createAuthFlagReadsetReactor({
			materializations: [visibleOrders()],
			sessions: [
				event("session:alice", 1, "session.Started", {
					sessionId: "session-alice",
					principalId: "user:alice",
				}),
			],
			events: orderEvents.slice(0, 20),
		});
		reactor.subscribe({
			subscriptionId: "sub:alice-orders",
			materialization: "visibleOrders",
			principal: { id: "user:alice", sessionId: "session-alice" },
			client: { push: () => {} },
		});
		reactor.append(
			event("session:alice", 2, "session.Revoked", {
				sessionId: "session-alice",
				principalId: "user:alice",
				reason: "bench",
			}),
		);
	});
});
