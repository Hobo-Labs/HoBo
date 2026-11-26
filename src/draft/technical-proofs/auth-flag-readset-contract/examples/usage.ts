/**
 * Runnable example for auth-flag-readset-contract. The draft-artifact gate EXECUTES
 * this with `node --import tsx` and diffs stdout against usage.expected.txt.
 *
 * Proves HOBO-269: materialized views declare an explicit READ-SET (event types +
 * auth/flag state). session.Revoked and flag.Changed wake exactly the subscriptions
 * whose read-set they touch and push recomputed results server-side (no polling);
 * hidden flag reads outside the read-set are rejected; auth recompute failure fails
 * closed to deny.
 */
import { strict as assert } from "node:assert";

import { createAuthFlagReadsetReactor, defineMaterialization } from "../src/auth-flag-readset.ts";
import { type JsonValue, type JsonObject } from "../src/json.js";


type Pushed = {
	type: string;
	subscriptionId: string;
	decision: string;
	reason?: string;
	result: JsonValue[];
};

const event = (streamId: string, seq: number, type: string, data: JsonObject) => ({
	streamId,
	seq,
	type,
	data,
});
const pushCollector = (events: Pushed[]) => ({ push: (e: Pushed) => events.push(e) });

const flaggedOrders = defineMaterialization({
	name: "flaggedOrders",
	readSet: [
		{ kind: "eventType", value: "order.Visible" },
		{ kind: "authState", value: "session" },
		{ kind: "flagState", value: "show-vip-orders" },
	],
	initialState: [],
	fold(state: Array<{ id: string; value: number }>, e: any, context: any) {
		if (e.type !== "order.Visible") return state;
		if (!context.flag("show-vip-orders")) return state;
		if (e.data.owner !== context.principal.id || e.data.tier !== "vip") return state;
		return [...state, { id: e.data.orderId, value: e.data.value }];
	},
});

// 1) flag.Changed wakes the subscription whose read-set includes the flag and re-pushes.
const pushed: Pushed[] = [];
const reactor = createAuthFlagReadsetReactor({
	materializations: [flaggedOrders],
	sessions: [
		event("session:alice", 1, "session.Started", {
			sessionId: "session-alice",
			principalId: "user:alice",
		}),
	],
	flags: [event("flag:show-vip-orders", 1, "flag.Defined", { key: "show-vip-orders", value: false })],
	events: [
		event("orders", 1, "order.Visible", {
			orderId: "vip-1",
			owner: "user:alice",
			tier: "vip",
			value: 99,
		}),
	],
});
reactor.subscribe({
	subscriptionId: "sub:alice-vip-orders",
	materialization: "flaggedOrders",
	principal: { id: "user:alice", sessionId: "session-alice" },
	client: pushCollector(pushed),
});

const flagWake = reactor.append(
	event("flag:show-vip-orders", 2, "flag.Changed", { key: "show-vip-orders", value: true }),
);
assert.deepEqual(flagWake.wokenSubscriptions, ["sub:alice-vip-orders"]);
assert.equal(pushed.length, 1);
assert.equal(pushed[0].decision, "allow");
assert.deepEqual(pushed[0].result, [{ id: "vip-1", value: 99 }]);
console.log(
	`flag.Changed: woke=${flagWake.wokenSubscriptions.join(",")} decision=${pushed[0].decision} rows=${pushed[0].result.length}`,
);

// 2) session.Revoked recomputes to DENY and empties the result — no client polling.
const revokeWake = reactor.append(
	event("session:alice", 2, "session.Revoked", {
		sessionId: "session-alice",
		principalId: "user:alice",
		reason: "sign-out-everywhere",
	}),
);
assert.deepEqual(revokeWake.wokenSubscriptions, ["sub:alice-vip-orders"]);
// SAFETY: `const revokedPush = pushed.at(-1) as Pushed;` is required at this I/O or test boundary.
const revokedPush = pushed.at(-1) as Pushed;
assert.equal(revokedPush.decision, "deny");
assert.equal(revokedPush.reason, "session-revoked");
assert.deepEqual(revokedPush.result, []);
console.log(
	`session.Revoked: woke=${revokeWake.wokenSubscriptions.join(",")} decision=${revokedPush.decision} reason=${revokedPush.reason} rows=${revokedPush.result.length}`,
);

// 3) A materialization that reads a flag OUTSIDE its declared read-set is rejected.
const hidden = defineMaterialization({
	name: "hiddenFlagDependency",
	readSet: [
		{ kind: "eventType", value: "order.Visible" },
		{ kind: "authState", value: "session" },
	],
	initialState: [],
	fold(state: JsonValue[], e: any, context: any) {
		if (e.type !== "order.Visible" || !context.flag("show-vip-orders")) return state;
		return [...state, { id: e.data.orderId }];
	},
});
const strictReactor = createAuthFlagReadsetReactor({
	materializations: [hidden],
	sessions: [
		event("session:alice", 1, "session.Started", {
			sessionId: "session-alice",
			principalId: "user:alice",
		}),
	],
	flags: [event("flag:show-vip-orders", 1, "flag.Defined", { key: "show-vip-orders", value: true })],
	events: [
		event("orders", 1, "order.Visible", {
			orderId: "vip-1",
			owner: "user:alice",
			tier: "vip",
			value: 99,
		}),
	],
});
assert.throws(
	() =>
		strictReactor.subscribe({
			subscriptionId: "sub:hidden-flag",
			materialization: "hiddenFlagDependency",
			principal: { id: "user:alice", sessionId: "session-alice" },
			client: pushCollector([]),
		}),
	/flag read missing readSet member: show-vip-orders/,
);
console.log("hidden flag read: rejected (flag read missing readSet member: show-vip-orders)");

// 4) Auth recompute failure fails CLOSED: deny, not stale privileged rows.
let authBackendFails = false;
const privileged = defineMaterialization({
	name: "privilegedOrders",
	readSet: [
		{ kind: "eventType", value: "order.Visible" },
		{ kind: "authState", value: "session" },
	],
	initialState: [],
	authorize() {
		if (authBackendFails) throw new Error("policy cache unavailable");
		return true;
	},
	fold(state: Array<{ id: string; value: number }>, e: any, context: any) {
		if (e.type !== "order.Visible" || e.data.owner !== context.principal.id) return state;
		return [...state, { id: e.data.orderId, value: e.data.value }];
	},
});
const privilegedPushed: Pushed[] = [];
const failClosedReactor = createAuthFlagReadsetReactor({
	materializations: [privileged],
	sessions: [
		event("session:alice", 1, "session.Started", {
			sessionId: "session-alice",
			principalId: "user:alice",
		}),
	],
	events: [
		event("orders", 1, "order.Visible", { orderId: "secret-1", owner: "user:alice", value: 4200 }),
	],
});
failClosedReactor.subscribe({
	subscriptionId: "sub:alice-privileged",
	materialization: "privilegedOrders",
	principal: { id: "user:alice", sessionId: "session-alice" },
	client: pushCollector(privilegedPushed),
});
authBackendFails = true;
failClosedReactor.append(
	event("session:alice", 2, "session.Refreshed", {
		sessionId: "session-alice",
		principalId: "user:alice",
	}),
);
// SAFETY: `const failClosedPush = privilegedPushed.at(-1) as Pushed;` is required at this I/O or test boundary.
const failClosedPush = privilegedPushed.at(-1) as Pushed;
assert.equal(failClosedPush.decision, "deny");
assert.equal(failClosedPush.reason, "auth-recompute-failed");
assert.deepEqual(failClosedPush.result, []);
console.log(
	`auth backend down: decision=${failClosedPush.decision} reason=${failClosedPush.reason} rows=${failClosedPush.result.length}`,
);

console.log("CONTRACT HELD: read-set-driven wakes, server push, fail-closed auth recompute");
