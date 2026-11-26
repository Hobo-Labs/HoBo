import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  ReplayDivergenceError,
  canonicalStateBytes,
  defineWorkflow,
  stableStringify,
  testRuntime,
} from "../src/test-runtime.js";
import { isJsonNumber, type JsonValue } from "../src/json.js";


const checkoutWorkflow = defineWorkflow("checkout", {
  initialState: (order: { id: string }) => ({
    orderId: order.id,
    status: "started",
    approved: false,
    charged: false,
    // SAFETY: assertion to `startedAt: null as string | null,` is required at this boundary.
    startedAt: null as string | null,
    // SAFETY: assertion to `paymentDueAt: null as string | null,` is required at this boundary.
    paymentDueAt: null as string | null,
    // SAFETY: assertion to `settledAt: null as string | null,` is required at this boundary.
    settledAt: null as string | null,
    // SAFETY: assertion to `actorSignal: null as string | null,` is required at this boundary.
    actorSignal: null as string | null,
    // SAFETY: assertion to `sagaReaction: null as string | null,` is required at this boundary.
    sagaReaction: null as string | null,
  }),
  onStart(ctx, state, order) {
    ctx.emit("checkout.Started", { orderId: order.id });
    ctx.emit("actor.OrderPlaced", { orderId: order.id });
    ctx.emit("saga.FulfillmentRequested", { orderId: order.id });
    ctx.waitForHook("approval");
    return { ...state, startedAt: ctx.now(), actorSignal: "placed", sagaReaction: "requested" };
  },
  onHook(ctx, state, payload) {
    // SAFETY: assertion to `if ((payload as { ok?: boolean }).ok !== true) {` is required at this boundary.
    if ((payload as { ok?: boolean }).ok !== true) {
      return { ...state, status: "rejected" };
    }
    const timer = ctx.sleep(10_000, { id: "settle-payment", label: "payment-settle" });
    return { ...state, approved: true, paymentDueAt: timer.fireAt, status: "waiting-for-payment" };
  },
  onTimer(ctx, state, timer) {
    if (timer.label !== "payment-settle") {
      return state;
    }
    ctx.emit("checkout.Confirmed", { orderId: state.orderId });
    return { ...state, charged: true, settledAt: timer.fireAt, status: "confirmed" };
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

    assert.deepEqual(replayed, live);
    assert.equal(stableStringify(replayed), stableStringify(live));
    assert.equal(canonicalStateBytes(replayed), canonicalStateBytes(live));
    assert.equal(live.status, "confirmed");
    assert.equal(live.actorSignal, "placed");
    assert.equal(live.sagaReaction, "requested");
  });

  it("fails replay when ambient Date.now is read in the workflow body", async () => {
    const badWorkflow = defineWorkflow("bad-clock", {
      // SAFETY: assertion to `initialState: () => ({ sample: null as number | null }),` is required at this boundary.
      initialState: () => ({ sample: null as number | null }),
      onStart() {
        return { sample: Date.now() };
      },
    });

    const runtime = testRuntime();
    const run = await runtime.start(badWorkflow, {});

    await assert.rejects(() => runtime.replay(run), (error: JsonValue) => {
      assert.ok(error instanceof ReplayDivergenceError);
      assert.ok(error.liveOrder.length > 0);
      assert.ok(error.replayOrder.length > 0);
      assert.notEqual(error.divergence.liveStateDigest, error.divergence.replayStateDigest);
      return true;
    });
  });

  it("allows Date.now inside a memoized step without divergence", async () => {
    const controlWorkflow = defineWorkflow("step-clock", {
      // SAFETY: assertion to `initialState: () => ({ sample: null as number | null }),` is required at this boundary.
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

    assert.deepEqual(replayed, live);
    assert.equal(isJsonNumber(live.sample), true);
  });
});
