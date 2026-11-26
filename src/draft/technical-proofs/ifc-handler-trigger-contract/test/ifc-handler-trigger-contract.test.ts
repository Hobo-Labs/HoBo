import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  TriggerContractError,
  api,
  bucket,
  compileHandlerManifest,
  schedule,
  topic,
  workflow,
} from "../src/ifc-handler-trigger-contract.js";

function noop() {}

describe("IfC handler and trigger attachment contract", () => {
  it("lowers HTTP routes, topic subscriptions, and cron handlers to WIT exports and manifest trigger edges", () => {
    const app = api("api");
    const orders = topic("orders");
    const nightly = schedule("nightly");

    app.get("/orders/:id", noop);
    orders.subscribe("orders.ingested", noop);
    nightly.cron("0 2 * * *", noop);

    const manifest = compileHandlerManifest([app, orders, nightly]);

    assert.equal(manifest.schema, "hobo.manifest/v1");
    assert.deepEqual(manifest.resources.api.exports, ["wasi:http/incoming-handler"]);
    assert.deepEqual(
      manifest.triggerEdges.map(({ kind, resource, exportInterface }) => ({
        kind,
        resource,
        exportInterface,
      })),
      [
        {
          kind: "http.route",
          resource: "api",
          exportInterface: "wasi:http/incoming-handler",
        },
        {
          kind: "topic.subscribe",
          resource: "orders",
          exportInterface: "hobo:trigger/topic-subscriber",
        },
        {
          kind: "schedule.cron",
          resource: "nightly",
          exportInterface: "hobo:trigger/scheduled-run",
        },
      ],
    );
    assert.deepEqual(manifest.resources.orders.allow, ["subscribe"]);
  });

  it("records workflow subscribers as durable-runtime linked trigger handlers", () => {
    const orders = topic("orders");
    orders.subscribe(
      "orders.created",
      workflow("fulfill-order", async function fulfillOrder() {}),
    );

    const manifest = compileHandlerManifest([orders]);
    assert.deepEqual(manifest.triggerEdges[0].durableRuntime, {
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
    assert.deepEqual(manifest.triggerEdges[0], {
      id: "uploads.write",
      kind: "bucket.on",
      resource: "uploads",
      event: "write",
      exportInterface: "hobo:trigger/blob-event",
      handler: "noop",
      inferredPermissions: ["event:write", "read"],
    });
  });
});
