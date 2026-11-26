import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  TriggerDispatcher,
  compileHandlerManifest,
  api,
  bucket,
  createLocalEventStore,
  createRuntimeLocalPorts,
  queue,
  schedule,
  topic,
} from "../src/index.js";
import { type JsonValue } from "../src/json.js";


describe("HOBO-608 TriggerDispatcher", () => {
  it("dispatches all five trigger kinds and emits trigger.Fired events", async () => {
    const ports = createRuntimeLocalPorts();
    const eventStore = createLocalEventStore();
    const handlers = new Map<string, (ctx: JsonValue) => JsonValue | Promise<JsonValue>>();

    async function httpHandler() {
      return { message: "ok" };
    }
    Object.defineProperty(httpHandler, "name", { value: "httpHandler" });

    async function topicHandler() {}
    Object.defineProperty(topicHandler, "name", { value: "topicHandler" });

    async function scheduleHandler() {}
    Object.defineProperty(scheduleHandler, "name", { value: "scheduleHandler" });

    async function bucketHandler() {}
    Object.defineProperty(bucketHandler, "name", { value: "bucketHandler" });

    async function queueHandler() {}
    Object.defineProperty(queueHandler, "name", { value: "queueHandler" });

    handlers.set("httpHandler", httpHandler);
    handlers.set("topicHandler", topicHandler);
    handlers.set("scheduleHandler", scheduleHandler);
    handlers.set("bucketHandler", bucketHandler);
    handlers.set("queueHandler", queueHandler);

    const app = api("api");
    const orders = topic("orders");
    const nightly = schedule("nightly");
    const uploads = bucket("uploads");
    const jobs = queue("jobs");

    app.get("/ok", httpHandler);
    orders.subscribe("evt", topicHandler);
    nightly.every("1s", scheduleHandler);
    uploads.on("write", bucketHandler);
    jobs.worker(queueHandler);

    const manifest = compileHandlerManifest([app, orders, nightly, uploads, jobs]);
    const dispatcher = new TriggerDispatcher({
      // SAFETY: assertion to `manifest: manifest as { schema: "hobo.manifest/v1"; triggerEdges: typeof manifes` is required at this boundary.
      manifest: manifest as { schema: "hobo.manifest/v1"; triggerEdges: typeof manifest.triggerEdges },
      ports,
      eventStore,
      handlers: { get: (name) => handlers.get(name) },
    });
    dispatcher.wire();

    const http = await dispatcher.handleHttp({ method: "GET", path: "/ok" });
    assert.equal(http.status, 200);

    await dispatcher.publishTopic("orders", "evt", { id: 1 });
    await dispatcher.tickSchedule("nightly");
    await dispatcher.writeBucket("uploads", "a.txt", "data");
    await dispatcher.enqueueQueue("jobs", { task: 1 });

    assert.equal(dispatcher.firedEvents.length, 5);
    assert.ok(dispatcher.firedEvents.every((event) => event.type === "trigger.Fired" && event.success));
    assert.ok(ports.queue.completed.length === 1);
  });
});
