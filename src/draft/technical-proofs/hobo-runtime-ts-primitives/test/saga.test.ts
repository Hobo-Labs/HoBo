import assert from "node:assert/strict";
import { test } from "vitest";

import { saga, testRuntime } from "../src/index.js";

test("saga failure event drives exactly one saga.Compensated", async () => {
  const rt = testRuntime();
  let compensationCount = 0;

  const fulfillment = saga("fulfillment")
    .on("OrderConfirmed", async () => {})
    .compensate("PaymentFailed", async () => {
      compensationCount += 1;
    })
    .build();

  rt.registerSaga(fulfillment);
  await rt.emit("PaymentFailed", { orderId: "ord-1" });

  assert.equal(compensationCount, 1);
  const events = await rt.allEvents();
  const compensated = events.filter((event) => event.type === "saga.Compensated");
  assert.equal(compensated.length, 1);
});
