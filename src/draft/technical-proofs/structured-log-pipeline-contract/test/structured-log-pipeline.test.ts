import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createMemoryLogSink,
  createStructuredLogPipeline
} from "../src/structured-log-pipeline.js";

const TRACE_ID = "11111111111111111111111111111111";
const TRACEPARENT = `00-${TRACE_ID}-2222222222222222-01`;

const runContext = Object.freeze({
  tenant: "tenant_a",
  runId: "run_checkout_1",
  resource: "bindle://checkout/deploy",
  traceparent: TRACEPARENT
});

test("ctx.log auto-tags records and live tail receives them before run completion", () => {
  const historicalSink = createMemoryLogSink("otlp-logs");
  const pipeline = createStructuredLogPipeline({ sinks: [historicalSink] });
  const tail = pipeline.subscribeRun(runContext.runId, { subscriberId: "hobo-logs" });
  const ctx = pipeline.createContext(runContext);

  const result = ctx.log.info("deployment started", { deploymentId: "dep_123" }, { nowMs: 25 });

  assert.equal(result.accepted, true);
  assert.equal(result.entry.tenant, runContext.tenant);
  assert.equal(result.entry.runId, runContext.runId);
  assert.equal(result.entry.resource, runContext.resource);
  assert.equal(result.entry.traceId, TRACE_ID);
  assert.deepEqual(result.entry.tags, {
    tenant: runContext.tenant,
    runId: runContext.runId,
    resource: runContext.resource,
    traceId: TRACE_ID
  });
  assert.equal(pipeline.runStatus(runContext.runId).completed, false);
  assert.deepEqual(
    tail.readAll().map((entry) => [entry.seq, entry.message, entry.traceId]),
    [[1, "deployment started", TRACE_ID]]
  );
  assert.deepEqual(
    historicalSink.entries.map((entry) => [entry.seq, entry.message, entry.traceId]),
    [[1, "deployment started", TRACE_ID]]
  );
});

test("log traceId matches the enclosing traceparent and malformed traceparents fail closed", () => {
  const pipeline = createStructuredLogPipeline();
  const ctx = pipeline.createContext(runContext);

  const logged = ctx.log.warn("using existing deployment", {}, { nowMs: 30 });

  assert.equal(logged.entry.traceparent, TRACEPARENT);
  assert.equal(logged.entry.traceId, TRACE_ID);
  assert.throws(
    () => pipeline.createContext({ ...runContext, traceparent: "not-a-traceparent" }),
    /valid W3C traceparent/
  );
});

test("level filtering drops below-threshold records before tail or export", () => {
  const historicalSink = createMemoryLogSink("file");
  const pipeline = createStructuredLogPipeline({
    minimumLevel: "warn",
    sinks: [historicalSink]
  });
  const tail = pipeline.subscribeRun(runContext.runId, { subscriberId: "operator-tail" });
  const ctx = pipeline.createContext(runContext);

  const debug = ctx.log.debug("verbose provider detail", {}, { nowMs: 10 });
  const error = ctx.log.error("provider failed", { code: "E_PROVIDER" }, { nowMs: 11 });

  assert.deepEqual(debug, {
    accepted: false,
    reason: "below-threshold",
    level: "debug",
    threshold: "warn"
  });
  assert.equal(error.accepted, true);
  assert.deepEqual(
    tail.readAll().map((entry) => entry.level),
    ["error"]
  );
  assert.deepEqual(
    historicalSink.entries.map((entry) => entry.level),
    ["error"]
  );
});

test("hot-loop log floods are rate-limited without blocking the run", () => {
  const pipeline = createStructuredLogPipeline({
    rateLimit: { maxPerWindow: 2, windowMs: 1000 }
  });
  const tail = pipeline.subscribeRun(runContext.runId, { subscriberId: "fast-tail" });
  const ctx = pipeline.createContext(runContext);

  const results = Array.from({ length: 5 }, (_, index) =>
    ctx.log.info("poll tick", { index }, { nowMs: 100 })
  );

  assert.deepEqual(
    results.map((result) => result.accepted),
    [true, true, false, false, false]
  );
  assert.deepEqual(
    results.slice(2).map((result) => result.reason),
    ["rate-limited", "rate-limited", "rate-limited"]
  );
  assert.equal(pipeline.runStatus(runContext.runId).dropped.rateLimited, 3);
  assert.deepEqual(
    tail.readAll().map((entry) => entry.fields.index),
    [0, 1]
  );
});

test("structured secret fields are redacted before live tail and historical export", () => {
  const historicalSink = createMemoryLogSink("object-store");
  const pipeline = createStructuredLogPipeline({ sinks: [historicalSink] });
  const tail = pipeline.subscribeRun(runContext.runId, { subscriberId: "security-tail" });
  const ctx = pipeline.createContext(runContext);

  ctx.log.info(
    "provider credentials loaded",
    {
      username: "deploy-bot",
      apiToken: "tok_live_secret",
      nested: {
        password: "hunter2"
      }
    },
    { nowMs: 44 }
  );

  const [liveEntry] = tail.readAll();
  const [exportedEntry] = historicalSink.entries;

  assert.equal(liveEntry.fields.username, "deploy-bot");
  assert.equal(liveEntry.fields.apiToken, "[REDACTED]");
  assert.equal(liveEntry.fields.nested.password, "[REDACTED]");
  assert.deepEqual(exportedEntry.fields, liveEntry.fields);
  assert.equal(JSON.stringify(liveEntry).includes("tok_live_secret"), false);
  assert.equal(JSON.stringify(exportedEntry).includes("hunter2"), false);
});

test("tail subscriber disconnects do not collapse delivery to healthy subscribers", () => {
  const pipeline = createStructuredLogPipeline();
  const disconnected = pipeline.subscribeRun(runContext.runId, { subscriberId: "closed-tab" });
  const healthy = pipeline.subscribeRun(runContext.runId, { subscriberId: "cli-tail" });
  const ctx = pipeline.createContext(runContext);

  disconnected.disconnect("client-disconnected");
  const result = ctx.log.info("run still streaming", {}, { nowMs: 70 });

  assert.equal(result.accepted, true);
  assert.deepEqual(result.skippedSubscribers, ["closed-tab"]);
  assert.deepEqual(disconnected.readAll(), []);
  assert.deepEqual(
    healthy.readAll().map((entry) => entry.message),
    ["run still streaming"]
  );
  assert.equal(pipeline.runStatus(runContext.runId).subscribers.connected, 1);
});

test("concurrent producers in one run receive monotonic per-run ordering", async () => {
  const pipeline = createStructuredLogPipeline();
  const tail = pipeline.subscribeRun(runContext.runId, { subscriberId: "ordering-tail" });
  const resources = ["planner", "executor", "gateway", "watcher"];

  await Promise.all(
    resources.map(async (resource) => {
      const ctx = pipeline.createContext({
        ...runContext,
        resource: `bindle://checkout/${resource}`
      });
      return ctx.log.info("producer emitted", { resource }, { nowMs: 100 });
    })
  );

  assert.deepEqual(
    pipeline.history(runContext.runId).map((entry) => entry.seq),
    [1, 2, 3, 4]
  );
  assert.deepEqual(
    tail.readAll().map((entry) => entry.seq),
    [1, 2, 3, 4]
  );
});
