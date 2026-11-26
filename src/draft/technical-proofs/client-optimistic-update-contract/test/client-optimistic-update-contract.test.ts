import assert from "node:assert/strict";
import { test } from "vitest";

import {
  OptimisticSeqRegressionError,
  createOptimisticSubscription,
} from "../src/client-optimistic-update-contract.js";

test("optimistic patch shows immediately and reconciles on authoritative push at the command seq", () => {
  const client = createOptimisticSubscription({
    subscriptionId: "sub:cart",
    initial: snapshot({ "cart:1": 1 }, { items: [{ sku: "book", qty: 1 }] }),
  });

  const optimistic = client.applyOptimisticPatch({
    commandId: "cmd:add-pen",
    seqFloor: { "cart:1": 2 },
    apply(data) {
      return { items: [...data.items, { sku: "pen", qty: 1 }] };
    },
  });

  assert.deepEqual(optimistic, {
    data: { items: [{ sku: "book", qty: 1 }, { sku: "pen", qty: 1 }] },
    seq: { "cart:1": 1 },
    stale: true,
    optimistic: true,
    pendingCommands: ["cmd:add-pen"],
  });

  const reconciled = client.receiveAuthoritativePush(
    snapshot({ "cart:1": 2 }, { items: [{ sku: "book", qty: 1 }, { sku: "pen", qty: 1 }] }),
  );

  assert.deepEqual(reconciled, {
    data: { items: [{ sku: "book", qty: 1 }, { sku: "pen", qty: 1 }] },
    seq: { "cart:1": 2 },
    stale: false,
    optimistic: false,
    pendingCommands: [],
  });
});

test("rejected command rolls back its optimistic patch without leaving stuck state", () => {
  const client = createOptimisticSubscription({
    subscriptionId: "sub:todo",
    initial: snapshot({ "todo:1": 7 }, { done: false, text: "ship" }),
  });

  client.applyOptimisticPatch({
    commandId: "cmd:complete",
    seqFloor: { "todo:1": 8 },
    apply: (data) => ({ ...data, done: true }),
  });

  const rolledBack = client.rejectCommand("cmd:complete", {
    reason: "command rejected by aggregate invariant",
  });

  assert.deepEqual(rolledBack, {
    data: { done: false, text: "ship" },
    seq: { "todo:1": 7 },
    stale: false,
    optimistic: false,
    pendingCommands: [],
  });
  assert.deepEqual(client.auditLog().at(-1), {
    type: "optimistic.Rejected",
    commandId: "cmd:complete",
    reason: "command rejected by aggregate invariant",
  });
});

test("optimistic value never advances or regresses the authoritative seq", () => {
  const client = createOptimisticSubscription({
    subscriptionId: "sub:counter",
    initial: snapshot({ "counter:main": 3 }, { value: 3 }),
  });

  client.applyOptimisticPatch({
    commandId: "cmd:inc",
    seqFloor: { "counter:main": 4 },
    apply: (data) => ({ value: data.value + 1 }),
  });

  assert.deepEqual(client.current().seq, { "counter:main": 3 });
  assert.throws(
    () => client.receiveAuthoritativePush(snapshot({ "counter:main": 2 }, { value: 2 })),
    OptimisticSeqRegressionError,
  );
  assert.deepEqual(client.current().seq, { "counter:main": 3 });
});

test("authoritative push cannot omit a previously tracked stream seq", () => {
  const client = createOptimisticSubscription({
    subscriptionId: "sub:counter",
    initial: snapshot({ "counter:main": 3 }, { value: 3 }),
  });

  assert.throws(
    () => client.receiveAuthoritativePush(snapshot({}, { value: 4 })),
    OptimisticSeqRegressionError,
  );
  assert.deepEqual(client.current().seq, { "counter:main": 3 });
});

test("two overlapping optimistic patches replay in command seq order", () => {
  const client = createOptimisticSubscription({
    subscriptionId: "sub:counter",
    initial: snapshot({ "counter:main": 10 }, { value: 10 }),
  });

  client.applyOptimisticPatch({
    commandId: "cmd:plus-one",
    seqFloor: { "counter:main": 11 },
    apply: (data) => ({ value: data.value + 1 }),
  });
  client.applyOptimisticPatch({
    commandId: "cmd:times-two",
    seqFloor: { "counter:main": 12 },
    apply: (data) => ({ value: data.value * 2 }),
  });

  assert.deepEqual(client.current().data, { value: 22 });

  client.receiveAuthoritativePush(snapshot({ "counter:main": 11 }, { value: 11 }));

  assert.deepEqual(client.current(), {
    data: { value: 22 },
    seq: { "counter:main": 11 },
    stale: true,
    optimistic: true,
    pendingCommands: ["cmd:times-two"],
  });

  client.receiveAuthoritativePush(snapshot({ "counter:main": 12 }, { value: 22 }));

  assert.deepEqual(client.current(), {
    data: { value: 22 },
    seq: { "counter:main": 12 },
    stale: false,
    optimistic: false,
    pendingCommands: [],
  });
});

test("authoritative push arriving before the local patch makes the patch a no-op", () => {
  const client = createOptimisticSubscription({
    subscriptionId: "sub:ticket",
    initial: snapshot({ "ticket:1": 1 }, { status: "open" }),
  });

  client.receiveAuthoritativePush(snapshot({ "ticket:1": 2 }, { status: "closed" }));
  const result = client.applyOptimisticPatch({
    commandId: "cmd:close",
    seqFloor: { "ticket:1": 2 },
    apply: (data) => ({ ...data, status: "closed" }),
  });

  assert.deepEqual(result, {
    data: { status: "closed" },
    seq: { "ticket:1": 2 },
    stale: false,
    optimistic: false,
    pendingCommands: [],
  });
  assert.deepEqual(client.auditLog().at(-1), {
    type: "optimistic.AlreadySatisfied",
    commandId: "cmd:close",
    seqFloor: { "ticket:1": 2 },
  });
});

function snapshot(seq, data) {
  return { seq, data, stale: false };
}
