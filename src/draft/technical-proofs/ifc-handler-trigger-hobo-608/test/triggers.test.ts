import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  TriggerContractError,
  api,
  bucket,
  compileHandlerManifest,
  queue,
  schedule,
  topic,
  workflow,
} from "../src/triggers.js";

function noop() {}

describe("HOBO-608 IfC handler and trigger attachment", () => {
  it("lowers all five trigger kinds with pinned exportInterface values", () => {
    const app = api("api");
    const orders = topic("orders");
    const nightly = schedule("nightly");
    const uploads = bucket("uploads");
    const jobs = queue("jobs");

    app.get("/orders/:id", noop);
    orders.subscribe("orders.ingested", noop);
    nightly.cron("0 2 * * *", noop);
    uploads.on("write", noop);
    jobs.worker(noop);

    const manifest = compileHandlerManifest([app, orders, nightly, uploads, jobs]);

    assert.deepEqual(
      manifest.triggerEdges!.map(({ kind, exportInterface }) => ({ kind, exportInterface })),
      [
        { kind: "http.route", exportInterface: "wasi:http/incoming-handler" },
        { kind: "topic.subscribe", exportInterface: "hobo:trigger/topic-subscriber" },
        { kind: "schedule.cron", exportInterface: "hobo:trigger/scheduled-run" },
        { kind: "bucket.on", exportInterface: "hobo:trigger/blob-event" },
        { kind: "queue.worker", exportInterface: "hobo:trigger/queue-worker" },
      ],
    );
    assert.deepEqual(manifest.resources.jobs.allow, ["dequeue"]);
  });

  it("lowers schedule.every to hobo:trigger/scheduled-run", () => {
    const tick = schedule("tick");
    tick.every("5s", noop);

    const manifest = compileHandlerManifest([tick]);
    assert.equal(manifest.triggerEdges![0].kind, "schedule.every");
    assert.equal(manifest.triggerEdges![0].exportInterface, "hobo:trigger/scheduled-run");
    assert.equal(manifest.triggerEdges![0].every, "5s");
  });

  it("records workflow subscribers as durable-runtime linked trigger handlers", () => {
    const orders = topic("orders");
    orders.subscribe(
      "orders.created",
      workflow("fulfill-order", async function fulfillOrder() {}),
    );

    const manifest = compileHandlerManifest([orders]);
    assert.deepEqual(manifest.triggerEdges![0].durableRuntime, {
      primitive: "workflow",
      interface: "hobo:runtime/workflow@0.1.0",
      handler: "fulfill-order",
    });
  });

  it("fails a trigger whose resource is not declared in the same Bindle manifest", () => {
    const orders = topic("orders");
    const trigger = orders.subscribe("orders.created", noop);

    assert.throws(
      () => compileHandlerManifest([], { triggers: [trigger] }),
      (error) => {
        assert.ok(error instanceof TriggerContractError);
        assert.match(error.message, /triggers\[0\]\.resource: orders is not declared in this Bindle/);
        return true;
      },
    );
  });

  it("rejects duplicate HTTP route method and path pairs", () => {
    const app = api("api");
    app.get("/orders/:id", noop);

    assert.throws(
      () => app.get("/orders/:id", noop),
      /resources\.api\.routes\[GET \/orders\/:id\]: duplicate route/,
    );
  });

  it("flags topic workflow subscribers on resources without a durable event path", () => {
    const orders = topic("orders", { durableEvents: false });

    assert.throws(
      () => orders.subscribe("orders.created", workflow("fulfill-order", noop)),
      /resources\.orders\.triggers\.orders\.created: workflow subscriber requires a durable event path/,
    );
  });

  it("infers read and event permissions for bucket write-event handlers", () => {
    const uploads = bucket("uploads");
    uploads.on("write", noop);

    const manifest = compileHandlerManifest([uploads]);

    assert.deepEqual(manifest.resources.uploads.allow, ["event:write", "read"]);
    assert.deepEqual(manifest.triggerEdges![0].inferredPermissions, ["event:write", "read"]);
  });
});
