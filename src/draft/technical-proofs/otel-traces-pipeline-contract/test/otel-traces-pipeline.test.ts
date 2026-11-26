import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createMockOtlpCollector,
  createOtelTracePipeline
} from "../src/otel-traces-pipeline.js";

const TRACE_ID = "11111111111111111111111111111111";
const TRACEPARENT = `00-${TRACE_ID}-0000000000000001-01`;

const deployContext = Object.freeze({
  tenant: "tenant-a",
  runId: "deploy-run-1",
  deploymentId: "deploy-1",
  traceparent: TRACEPARENT
});

test("a deploy exports one OTLP trace with nested step, actor, and provider spans", () => {
  const collector = createMockOtlpCollector();
  const pipeline = createOtelTracePipeline({
    collector,
    spanIds: [
      "0000000000000010",
      "0000000000000011",
      "0000000000000012",
      "0000000000000013"
    ],
    clock: [0, 4, 5, 9, 10, 14, 15, 20]
  });

  const deploy = pipeline.startDeploy(deployContext);
  pipeline.withSpan(deploy, "step.plan", { "hobo.step": "plan" }, (step) => {
    pipeline.withSpan(step, "actor.resource", { "hobo.actor": "resource:api" }, (actor) => {
      pipeline.instrumentProviderCall(
        actor,
        { provider: "aws", region: "us-east-1", op: "rds.create" },
        ({ traceparent }) => ({ ok: true, observedTraceparent: traceparent })
      );
    });
  });
  pipeline.endSpan(deploy, { "hobo.deploy.outcome": "planned" });

  const flushed = pipeline.flush({ nowMs: 25 });
  const [trace] = collector.tracesFor(TRACE_ID);
  const spans = trace.resourceSpans[0].scopeSpans[0].spans;

  assert.equal(flushed.exportedSpans, 4);
  assert.deepEqual(
    spans.map((span) => [span.name, span.parentSpanId]),
    [
      ["deploy", "0000000000000001"],
      ["step.plan", "0000000000000010"],
      ["actor.resource", "0000000000000011"],
      ["provider.aws.rds.create", "0000000000000012"]
    ]
  );
  assert.equal(spans[3].attributes["cloud.provider"], "aws");
  assert.equal(spans[3].attributes["cloud.region"], "us-east-1");
  assert.equal(spans[3].attributes["db.operation"], "rds.create");
});

test("collector export failures back off without throwing or failing run progress", () => {
  const collector = createMockOtlpCollector({ failAttempts: 1 });
  const pipeline = createOtelTracePipeline({
    collector,
    spanIds: ["0000000000000020"],
    clock: [0, 2],
    retryBaseMs: 1000
  });

  const deploy = pipeline.startDeploy(deployContext);
  pipeline.endSpan(deploy);

  const firstFlush = pipeline.flush({ nowMs: 10 });
  const skippedFlush = pipeline.flush({ nowMs: 11 });
  const retryFlush = pipeline.flush({ nowMs: 1010 });

  assert.equal(firstFlush.exportedSpans, 0);
  assert.equal(firstFlush.deferredSpans, 1);
  assert.equal(firstFlush.nextRetryAtMs, 1010);
  assert.equal(skippedFlush.exportedSpans, 0);
  assert.equal(skippedFlush.deferredSpans, 1);
  assert.equal(collector.attempts(), 2);
  assert.equal(retryFlush.exportedSpans, 1);
  assert.equal(collector.tracesFor(TRACE_ID).length, 1);
});

test("sampling drops spans at the configured rate while preserving child trace linkage", () => {
  const collector = createMockOtlpCollector();
  const pipeline = createOtelTracePipeline({
    collector,
    sampleRate: 0,
    spanIds: ["0000000000000030", "0000000000000031"],
    clock: [0, 1, 2, 3]
  });

  const deploy = pipeline.startDeploy(deployContext);
  const child = pipeline.withSpan(deploy, "step.drop", {}, (span) => span);
  pipeline.endSpan(deploy);
  const flushed = pipeline.flush({ nowMs: 5 });

  assert.equal(child.traceId, deploy.traceId);
  assert.equal(child.parentSpanId, deploy.spanId);
  assert.equal(flushed.exportedSpans, 0);
  assert.equal(flushed.droppedSampledSpans, 2);
  assert.deepEqual(collector.tracesFor(TRACE_ID), []);
});

test("bounded buffers drop span floods without blocking producer operations", () => {
  const collector = createMockOtlpCollector();
  const pipeline = createOtelTracePipeline({
    collector,
    maxBufferedSpans: 3,
    spanIds: Array.from({ length: 8 }, (_, index) =>
      (0x40 + index).toString(16).padStart(16, "0")
    ),
    clock: Array.from({ length: 16 }, (_, index) => index)
  });

  const deploy = pipeline.startDeploy(deployContext);
  const results = Array.from({ length: 7 }, (_, index) =>
    pipeline.withSpan(deploy, "provider.retry", { attempt: index + 1 }, () => "ok")
  );
  pipeline.endSpan(deploy);
  const flushed = pipeline.flush({ nowMs: 20 });

  assert.deepEqual(results, ["ok", "ok", "ok", "ok", "ok", "ok", "ok"]);
  assert.equal(flushed.exportedSpans, 3);
  assert.equal(flushed.droppedBufferSpans, 5);
});

test("provider SDK calls that swallow context are marked instead of breaking the trace", () => {
  const collector = createMockOtlpCollector();
  const pipeline = createOtelTracePipeline({
    collector,
    spanIds: ["0000000000000050", "0000000000000051"],
    clock: [0, 1, 2, 3]
  });

  const deploy = pipeline.startDeploy(deployContext);
  pipeline.instrumentProviderCall(
    deploy,
    { provider: "azure", region: "westus2", op: "queue.send" },
    () => ({ ok: true })
  );
  pipeline.endSpan(deploy);
  pipeline.flush({ nowMs: 5 });

  const spans = collector.tracesFor(TRACE_ID)[0].resourceSpans[0].scopeSpans[0].spans;
  const providerSpan = spans.find((span) => span.name === "provider.azure.queue.send");

  assert.equal(providerSpan.status.code, "ERROR");
  assert.equal(providerSpan.status.message, "provider-context-lost");
  assert.equal(providerSpan.parentSpanId, "0000000000000050");
});

test("deep nesting is capped with a trace attribute instead of overflowing or severing parents", () => {
  const collector = createMockOtlpCollector();
  const pipeline = createOtelTracePipeline({
    collector,
    maxDepth: 3,
    spanIds: [
      "0000000000000060",
      "0000000000000061",
      "0000000000000062",
      "0000000000000063",
      "0000000000000064"
    ],
    clock: Array.from({ length: 10 }, (_, index) => index)
  });

  const deploy = pipeline.startDeploy(deployContext);
  let current = deploy;
  for (let depth = 1; depth <= 4; depth += 1) {
    current = pipeline.startSpan(current, `nested.${depth}`);
  }
  for (let span = current; span; span = span.parent) {
    pipeline.endSpan(span);
  }

  pipeline.flush({ nowMs: 20 });
  const spans = collector.tracesFor(TRACE_ID)[0].resourceSpans[0].scopeSpans[0].spans;
  const capped = spans.find((span) => span.name === "nested.4");

  assert.equal(capped.attributes["hobo.depth_exceeded"], true);
  assert.equal(capped.parentSpanId, "0000000000000063");
});

test("PII and secret span attributes are redacted before buffering and OTLP export", () => {
  const collector = createMockOtlpCollector();
  const pipeline = createOtelTracePipeline({
    collector,
    spanIds: ["0000000000000070"],
    clock: [0, 1]
  });

  const deploy = pipeline.startDeploy(deployContext, {
    email: "user@example.com",
    apiToken: "tok_secret",
    nested: { password: "hunter2" }
  });
  pipeline.endSpan(deploy);
  pipeline.flush({ nowMs: 2 });

  const [span] = collector.tracesFor(TRACE_ID)[0].resourceSpans[0].scopeSpans[0].spans;

  assert.equal(span.attributes.email, "[REDACTED]");
  assert.equal(span.attributes.apiToken, "[REDACTED]");
  assert.equal(span.attributes.nested.password, "[REDACTED]");
  assert.equal(JSON.stringify(span).includes("tok_secret"), false);
  assert.equal(JSON.stringify(span).includes("hunter2"), false);
});
