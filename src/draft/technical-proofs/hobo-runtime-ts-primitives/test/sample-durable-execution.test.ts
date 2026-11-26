import assert from "node:assert/strict";
import { test } from "vitest";

import {
  actor,
  createHook,
  isCatalogEventType,
  saga,
  signal,
  sleep,
  step,
  testRuntime,
  workflow,
} from "../src/index.js";

const EXPECTED_ORDER_PREFIX = [
  "run.Started",
  "run.StepScheduled",
  "run.StepCompleted",
  "run.SleepScheduled",
  "run.HookCreated",
];

test("stage-gate sample: workflow + actor + saga with replay == live", async () => {
  const rt = testRuntime();
  let compensationFired = false;

  const fulfillment = saga("fulfillment")
    .on("OrderConfirmed", async (_event, ctx) => {
      await ctx.emit("FulfillmentStarted", { status: "packing" });
    })
    .compensate("PaymentFailed", async () => {
      compensationFired = true;
    })
    .build();
  rt.registerSaga(fulfillment);

  const cart = actor("checkout-cart", {
    state: () => ({ items: 0 }),
    on: {
      AddItem: (state) => ({ items: state.items + 1 }),
    },
  });

  const charge = step(async () => {
    rt.incrementSideEffect();
    return { transactionId: "txn-1", amount: 42 };
  });

  const checkout = workflow("checkout", async (orderId: string) => {
    const approval = createHook<{ approved: boolean }>("payment-approval");
    await sleep("50ms");
    const payment = await charge();
    await rt.emit("OrderConfirmed", { orderId, payment });
    await signal(cart.key(orderId), { type: "AddItem", payload: { sku: "widget" } });
    const decision = await approval.wait();
    return { orderId, payment, decision };
  });

  const run = await rt.start(checkout, ["ord-100"]);
  rt.clock.advance("50ms");
  await rt.continueRun(run);
  await rt.resumeHook(run, { approved: true });

  const finalState = await rt.state(run);
  assert.deepEqual(finalState?.decision, { approved: true });
  assert.equal(rt.getSideEffectCounter(), 1);
  assert.deepEqual(await rt.replay(run), finalState);
  assert.equal(compensationFired, false);

  const log = await rt.eventLog(run);
  for (const event of log) {
    assert.ok(isCatalogEventType(event.type), `non-catalog event: ${event.type}`);
  }

  const types = log.map((event) => event.type);
  for (const expected of EXPECTED_ORDER_PREFIX) {
    assert.ok(types.includes(expected), `missing ${expected}`);
  }
});

test("saga compensation path on payment failure", async () => {
  const rt = testRuntime();
  let compensationCount = 0;
  const fulfillment = saga("fulfillment-fail")
    .compensate("PaymentFailed", async () => {
      compensationCount += 1;
    })
    .build();
  rt.registerSaga(fulfillment);
  await rt.emit("PaymentFailed", { orderId: "ord-fail" });
  assert.equal(compensationCount, 1);
});
