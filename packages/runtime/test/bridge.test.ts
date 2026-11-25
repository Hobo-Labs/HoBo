import assert from "node:assert/strict";
import { test } from "vitest";

import {
	BoundaryRoutingError,
	BridgeContractError,
	createBoundaryRouter,
	isSubsetMatch,
} from "../src/index.js";

// The Bridge: Bridge-to-Kubernetes-style local/remote dev,
// generalized to every provider. These tests double as the executable
// example for site docs /guide/bridge/ — a storefront calling a deployed
// payments boundary, with a developer bridging just their own traffic to
// the process on their laptop.

interface Charge {
	readonly orderId: string;
	readonly amount: number;
}
interface Receipt {
	readonly orderId: string;
	readonly status: string;
	readonly processor?: string;
}

const deployedPayments = async (charge: Charge): Promise<Receipt> => ({
	orderId: charge.orderId,
	status: "charged",
	processor: "prod-v1",
});

// The boundary's PACT interactions — what any implementation must satisfy.
const PAYMENTS_CONTRACT = {
	examples: [
		{
			input: { orderId: "o-1", amount: 42 },
			output: { orderId: "o-1", status: "charged" },
		},
	],
};

test("bridge routes ONLY the tagged dev session; live traffic is untouched", async () => {
	const router = createBoundaryRouter();
	const payments = router
		.boundary<Charge, Receipt>("payments")
		.live(deployedPayments);

	// Dev fork: same contract, local behavior under development.
	await payments.bridge(
		async (charge) => ({
			orderId: charge.orderId,
			status: "charged",
			processor: "laptop-dev",
		}),
		{ session: "tyler/feature-refunds", contract: PAYMENTS_CONTRACT },
	);

	const mine = await payments.call(
		{ orderId: "o-1", amount: 42 },
		{ session: "tyler/feature-refunds" },
	);
	const theirs = await payments.call({ orderId: "o-2", amount: 7 });

	assert.equal(mine.processor, "laptop-dev");
	assert.equal(theirs.processor, "prod-v1");
	assert.deepEqual(
		payments.calls().map((call) => call.served),
		["bridge", "live"],
	);
});

test("a bridge that fails its PACT contract never activates", async () => {
	const router = createBoundaryRouter();
	const payments = router
		.boundary<Charge, Receipt>("payments")
		.live(deployedPayments);

	await assert.rejects(
		payments.bridge(
			async (charge) => ({ orderId: charge.orderId, status: "declined" }),
			{ session: "tyler/broken", contract: PAYMENTS_CONTRACT },
		),
		BridgeContractError,
	);
	// Traffic for that session still routes live — the fork never landed.
	const result = await payments.call(
		{ orderId: "o-3", amount: 1 },
		{ session: "tyler/broken" },
	);
	assert.equal(result.processor, "prod-v1");
});

test("a sessionless bridge forks the whole boundary; unbridge restores it", async () => {
	const router = createBoundaryRouter();
	const payments = router
		.boundary<Charge, Receipt>("payments")
		.live(deployedPayments);
	await payments.bridge(async (charge) => ({
		orderId: charge.orderId,
		status: "charged",
		processor: "fork",
	}));

	assert.equal(
		(await payments.call({ orderId: "o-4", amount: 1 })).processor,
		"fork",
	);
	payments.unbridge();
	assert.equal(
		(await payments.call({ orderId: "o-4", amount: 1 })).processor,
		"prod-v1",
	);
});

test("mock mode serves PACT examples when no live route exists (offline dev)", async () => {
	const router = createBoundaryRouter();
	const payments = router
		.boundary<Charge, Receipt>("payments")
		// SAFETY: assertion to `TS_CONTRACT.examples as never); c` is required at this boundary.
		// SAFETY: assertion to `TS_CONTRACT.examples as never); c` is required at this boundary.
		.mock(
			// SAFETY: pact examples are the mock table at this test boundary.
			PAYMENTS_CONTRACT.examples as never,
		);

	const matched = await payments.call({ orderId: "o-1", amount: 42 });
	assert.equal(matched.status, "charged");
	// Unmatched inputs get the first example as the canned typed response.
	const canned = await payments.call({ orderId: "o-9", amount: 1 });
	assert.equal(canned.orderId, "o-1");
});

test("replay serves recorded outputs — deployment testing without the dependency", async () => {
	const router = createBoundaryRouter();
	const payments = router
		.boundary<Charge, Receipt>("payments")
		.live(deployedPayments);
	await payments.call({ orderId: "o-1", amount: 42 });

	payments.replay();
	const replayed = await payments.call({ orderId: "o-1", amount: 42 });
	assert.equal(replayed.processor, "prod-v1");
	assert.equal(payments.calls().at(-1)?.served, "replay");
	await assert.rejects(
		payments.call({ orderId: "never-seen", amount: 0 }),
		BoundaryRoutingError,
	);
});

test("shadow duplicates served traffic to a candidate and reports diffs", async () => {
	const router = createBoundaryRouter();
	const payments = router
		.boundary<Charge, Receipt>("payments")
		.live(deployedPayments)
		.shadow(async (charge) => ({
			orderId: charge.orderId,
			status: charge.amount > 10 ? "charged" : "review",
			processor: "prod-v1",
		}));

	const served = await payments.call({ orderId: "o-1", amount: 42 });
	assert.equal(served.processor, "prod-v1"); // candidate output never returned
	await payments.call({ orderId: "o-2", amount: 3 });
	await new Promise((resolve) => setImmediate(resolve)); // let shadows settle

	const diffs = payments.shadowDiffs();
	assert.equal(diffs.length, 2);
	assert.equal(diffs[0]?.matched, true);
	assert.equal(diffs[1]?.matched, false);
});

test("fault injection scoped to a session: chaos without blast radius", async () => {
	const router = createBoundaryRouter();
	const payments = router
		.boundary<Charge, Receipt>("payments")
		.live(deployedPayments)
		.fault({ message: "simulated outage", session: "tyler/chaos" });

	await assert.rejects(
		payments.call({ orderId: "o-1", amount: 1 }, { session: "tyler/chaos" }),
		/simulated outage/,
	);
	// Everyone else is untouched.
	assert.equal(
		(await payments.call({ orderId: "o-1", amount: 1 })).status,
		"charged",
	);
	payments.clearFault();
	assert.equal(
		(
			await payments.call(
				{ orderId: "o-1", amount: 1 },
				{ session: "tyler/chaos" },
			)
		).status,
		"charged",
	);
});

test("router status summarizes every boundary's routing state", async () => {
	const router = createBoundaryRouter();
	const payments = router
		.boundary<Charge, Receipt>("payments")
		.live(deployedPayments);
	await payments.bridge(
		async (c) => ({ orderId: c.orderId, status: "charged" }),
		{
			session: "tyler/feature-refunds",
		},
	);
	router.boundary("catalog").mock([{ input: {}, output: { items: [] } }]);

	const status = router.status();
	assert.deepEqual(
		status.map((entry) => entry.boundary),
		["payments", "catalog"],
	);
	assert.deepEqual(status[0]?.bridgedSessions, ["tyler/feature-refunds"]);
	assert.equal(status[1]?.mockExamples, 1);
});

test("an unrouted boundary fails loudly, and subset matching is PACT-shaped", async () => {
	const router = createBoundaryRouter();
	await assert.rejects(
		router.boundary("nowhere").call({}),
		BoundaryRoutingError,
	);
	assert.equal(isSubsetMatch({ a: 1 }, { a: 1, b: 2 }), true);
	assert.equal(isSubsetMatch({ a: 1, b: 2 }, { a: 1 }), false);
	assert.equal(isSubsetMatch([{ a: 1 }], [{ a: 1, extra: true }]), true);
});
