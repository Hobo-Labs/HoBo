import { describe, expect, it } from "vitest";
import { isJsonNumber } from "../../src/json.js";

import {
	canonicalStateBytes,
	defineWorkflow,
	ReplayDivergenceError,
	stableStringify,
	testRuntime,
} from "../../src/replay/index.js";

const checkoutWorkflow = defineWorkflow("checkout", {
	initialState: (order: { id: string }) => ({
		orderId: order.id,
		status: "started",
		approved: false,
		charged: false,
		startedAt: null as string | null,
		paymentDueAt: null as string | null,
		settledAt: null as string | null,
		actorSignal: null as string | null,
		sagaReaction: null as string | null,
	}),
	onStart(ctx, state, order) {
		ctx.emit("checkout.Started", { orderId: order.id });
		ctx.emit("actor.OrderPlaced", { orderId: order.id });
		ctx.emit("saga.FulfillmentRequested", { orderId: order.id });
		ctx.waitForHook("approval");
		return {
			...state,
			startedAt: ctx.now(),
			actorSignal: "placed",
			sagaReaction: "requested",
		};
	},
	onHook(ctx, state, payload) {
		if ((payload as { ok?: boolean }).ok !== true) {
			return { ...state, status: "rejected" };
		}
		const timer = ctx.sleep(10_000, {
			id: "settle-payment",
			label: "payment-settle",
		});
		return {
			...state,
			approved: true,
			paymentDueAt: timer.fireAt,
			status: "waiting-for-payment",
		};
	},
	onTimer(ctx, state, timer) {
		if (timer.label !== "payment-settle") {
			return state;
		}
		ctx.emit("checkout.Confirmed", { orderId: state.orderId });
		return {
			...state,
			charged: true,
			settledAt: timer.fireAt,
			status: "confirmed",
		};
	},
});

describe("replay invariant fixtures", () => {
	it("asserts replay equals live for workflow + actor + saga interactions", async () => {
		const runtime = testRuntime({ seed: "checkout-seed" });
		const run = await runtime.start(checkoutWorkflow, { id: "order-1" });
		await runtime.resumeHook(run, { ok: true });
		await runtime.clock.advance(10_000);

		const live = await runtime.state(run);
		const replayed = await runtime.replay(run);

		expect(replayed).toEqual(live);
		expect(stableStringify(replayed)).toBe(stableStringify(live));
		expect(canonicalStateBytes(replayed)).toBe(canonicalStateBytes(live));
		expect(live.status).toBe("confirmed");
		expect(live.actorSignal).toBe("placed");
		expect(live.sagaReaction).toBe("requested");
	});

	it("fails replay when ambient Date.now is read in the workflow body", async () => {
		const badWorkflow = defineWorkflow("bad-clock", {
			initialState: () => ({ sample: null as number | null }),
			onStart() {
				return { sample: Date.now() };
			},
		});

		const runtime = testRuntime();
		const run = await runtime.start(badWorkflow, {});

		await expect(runtime.replay(run)).rejects.toSatisfy((error: Error) => {
			if (!(error instanceof ReplayDivergenceError)) {
				return false;
			}
			expect(error.liveOrder.length).toBeGreaterThan(0);
			expect(error.replayOrder.length).toBeGreaterThan(0);
			expect(error.divergence.liveStateDigest).not.toBe(
				error.divergence.replayStateDigest,
			);
			return true;
		});
	});

	it("allows Date.now inside a memoized step without divergence", async () => {
		const controlWorkflow = defineWorkflow("step-clock", {
			initialState: () => ({ sample: null as number | null }),
			async onStart(ctx, state) {
				const sample = await ctx.step("capture-clock", () => Date.now());
				return { ...state, sample };
			},
		});

		const runtime = testRuntime();
		const run = await runtime.start(controlWorkflow, {});
		const live = await runtime.state(run);
		const replayed = await runtime.replay(run);

		expect(replayed).toEqual(live);
		expect(isJsonNumber(live.sample)).toBe(true);
	});
});
