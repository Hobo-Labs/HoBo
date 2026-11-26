import assert from "node:assert/strict";
import { test } from "vitest";

import {
  OPENINFERENCE_LIVE_EVAL_STREAM_CONTRACT,
  createAiMethodTelemetryRuntime,
  createMockOpenInferenceBackend,
} from "../src/openinference-live-eval-stream.js";
import { validateEvalEvent } from "../../eval-promotion-gate-contract/src/eval-promotion-gate.js";

const TRACE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PARENT_SPAN_ID = "bbbbbbbbbbbbbbbb";
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`;

const run = Object.freeze({
  id: "run-ai-method-1",
  tenantId: "tenant-a",
  agentId: "agent:support-classifier",
  traceparent: TRACEPARENT,
});

const method = Object.freeze({
  name: "classifyTicket",
  contractRef: "contract://support/classifier@2.0.0",
  candidateId: "champion-v2",
});

const baseRequest = Object.freeze({
  messages: [{ role: "user", content: "Please route this refund ticket" }],
});

const baseResponse = Object.freeze({
  message: { role: "assistant", content: "billing-support" },
  route: "billing-support",
});

test("trainable method call emits nested OpenInference spans, trajectory reward, and mock backend export", () => {
  const backend = createMockOpenInferenceBackend();
  const runtime = createAiMethodTelemetryRuntime({
    backend,
    spanIds: ["0000000000000100", "0000000000000101"],
    clock: [
      "2026-06-26T21:40:00.000Z",
      "2026-06-26T21:40:00.020Z",
      "2026-06-26T21:40:00.040Z",
      "2026-06-26T21:40:00.050Z",
    ],
    runKeyRef: "run-key://run-ai-method-1",
  });

  const result = runtime.invokeTrainableMethod({
    run,
    method,
    request: baseRequest,
    response: baseResponse,
    model: { provider: "openai", name: "gpt-4o-mini" },
    tokenUsage: { prompt: 120, completion: 48, costUsd: 0.024 },
    latencyMs: 310,
    childSpans: [
      {
        kind: "LLM",
        name: "llm.classifyTicket",
        inputs: { promptTemplate: "route support ticket" },
        outputs: { label: "billing-support" },
      },
    ],
    liveEval: {
      rubricRef: "rubric://support/classifier@2.0.0",
      scores: { faithfulness: 0.97, piiSafe: 1 },
      thresholds: { faithfulness: 0.9, piiSafe: 1 },
      samples: 64,
      reward: 0.96,
      championScore: 0.94,
      challengerScore: 0.97,
    },
  });

  assert.equal(OPENINFERENCE_LIVE_EVAL_STREAM_CONTRACT, "hobo.openinference-live-eval-stream/v1");
  assert.equal(result.blocked, false);
  assert.equal(result.response, baseResponse);
  assert.deepEqual(
    result.spans.map((span) => [span.name, span.parentSpanId, span.attributes["openinference.span.kind"]]),
    [
      ["classifyTicket", PARENT_SPAN_ID, "CHAIN"],
      ["llm.classifyTicket", "0000000000000100", "LLM"],
    ],
  );
  assert.equal(result.spans[0].traceId, TRACE_ID);
  assert.equal(result.spans[0].attributes["llm.model_name"], "gpt-4o-mini");
  assert.equal(result.spans[0].attributes["llm.token_count.total"], 168);
  assert.equal(result.trajectory.run.id, run.id);
  assert.equal(result.trajectory.correlation.agentId, run.agentId);
  assert.equal(result.trajectory.reward.status, "scored");
  assert.equal(result.trajectory.reward.value, 0.96);

  const [exported] = backend.exports();
  assert.equal(exported.schema, "openinference.otlp.telemetry/v1");
  assert.equal(exported.spans[0].spanId, "0000000000000100");
  assert.equal(exported.trajectories[0].id, result.trajectory.id);
  assert.ok(exported.metrics.some((metric) => metric.name === "eval.score" && metric.value === 0.97));
  assert.ok(exported.events.some((event) => event.type === "eval.Ran"));
});

test("failed live eval emits eval.GateFailed plus SLO burn and drift signals", () => {
  const runtime = createAiMethodTelemetryRuntime({
    spanIds: ["0000000000000200"],
    runKeyRef: "run-key://run-ai-method-1",
  });

  const result = runtime.invokeTrainableMethod({
    run,
    method: { ...method, candidateId: "challenger-v3" },
    request: baseRequest,
    response: baseResponse,
    model: { provider: "openai", name: "gpt-4o-mini" },
    tokenUsage: { prompt: 80, completion: 20, costUsd: 0.013 },
    latencyMs: 280,
    liveEval: {
      rubricRef: "rubric://support/classifier@2.0.0",
      scores: { faithfulness: 0.71, piiSafe: 1 },
      thresholds: { faithfulness: 0.9, piiSafe: 1 },
      samples: 32,
      reward: 0.25,
      championScore: 0.94,
      challengerScore: 0.71,
    },
  });

  const events = result.events.map((event) => event.type);
  assert.ok(events.includes("eval.Ran"));
  assert.ok(events.includes("eval.GateFailed"));
  assert.ok(events.includes("slo.BudgetBurned"));
  assert.ok(events.includes("resource.DriftDetected"));
  const gateFailed = result.events.find((event) => event.type === "eval.GateFailed");
  const parsedGateFailed = validateEvalEvent(gateFailed);
  assert.equal(parsedGateFailed.ok, true, parsedGateFailed.errors.join("\n"));
  assert.equal(result.trajectory.reward.status, "scored");
  assert.equal(result.trajectory.reward.gate, "failed");
  assert.ok(result.metrics.some((metric) => metric.name === "eval.champion_challenger.delta" && metric.value === -0.23));
});

test("metrics catalog exposes invocation, eval, cost, shadow, and promotion telemetry names", () => {
  const runtime = createAiMethodTelemetryRuntime();

  assert.deepEqual(
    runtime.metricsCatalog().map((metric) => metric.name),
    [
      "ai.method.invocation.rate",
      "eval.score",
      "eval.champion_challenger.delta",
      "ai.token.cost_per_call",
      "ai.shadow_traffic.share",
      "eval.promotion.count",
    ],
  );
});

test("sensitive and large payloads are encrypted or offloaded before spans, events, and export", () => {
  const backend = createMockOpenInferenceBackend();
  const runtime = createAiMethodTelemetryRuntime({
    backend,
    spanIds: ["0000000000000300"],
    runKeyRef: "run-key://run-ai-method-1",
    maxInlinePayloadBytes: 24,
  });
  const secret = "alice@example.com says SSN 123-45-6789";
  const large = "x".repeat(200);

  const result = runtime.invokeTrainableMethod({
    run,
    method,
    request: { messages: [{ role: "user", content: secret }] },
    response: { message: { role: "assistant", content: large } },
    model: { provider: "openai", name: "gpt-4o-mini" },
    tokenUsage: { prompt: 12, completion: 6, costUsd: 0.002 },
    latencyMs: 90,
    sensitiveFields: ["request.messages.0.content"],
    liveEval: {
      rubricRef: "rubric://support/classifier@2.0.0",
      scores: { piiSafe: 1 },
      thresholds: { piiSafe: 1 },
      samples: 16,
      reward: 1,
    },
  });

  const serialized = JSON.stringify({
    spans: result.spans,
    trajectory: result.trajectory,
    events: result.events,
    metrics: result.metrics,
    exports: backend.exports(),
  });
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(large), false);
  assert.match(serialized, /"encryptedRef":"run:\/\/run-ai-method-1\/payloads\/request\.messages\.0\.content"/);
  assert.match(serialized, /"offloadRef":"run:\/\/run-ai-method-1\/offload\//);
  assert.match(serialized, /"runKeyRef":"run-key:\/\/run-ai-method-1"/);
});

test("eval errors do not block the request and missing rewards stay incomplete, not scored", () => {
  const runtime = createAiMethodTelemetryRuntime({
    spanIds: ["0000000000000400", "0000000000000401"],
    runKeyRef: "run-key://run-ai-method-1",
  });

  const errored = runtime.invokeTrainableMethod({
    run,
    method,
    request: baseRequest,
    response: baseResponse,
    model: { provider: "openai", name: "gpt-4o-mini" },
    tokenUsage: { prompt: 30, completion: 9, costUsd: 0.004 },
    latencyMs: 120,
    liveEval: {
      rubricRef: "rubric://support/classifier@2.0.0",
      error: "judge-timeout",
    },
  });

  assert.equal(errored.blocked, false);
  assert.equal(errored.response, baseResponse);
  assert.equal(errored.trajectory.reward.status, "incomplete");
  assert.equal(errored.trajectory.reward.reason, "live-eval-error");
  assert.ok(errored.events.some((event) => event.type === "eval.Ran" && event.data.status === "error"));
  assert.equal(errored.metrics.some((metric) => metric.name === "eval.score"), false);

  const missingReward = runtime.invokeTrainableMethod({
    run: { ...run, traceparent: "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01" },
    method,
    request: baseRequest,
    response: baseResponse,
    model: { provider: "openai", name: "gpt-4o-mini" },
    tokenUsage: { prompt: 30, completion: 9, costUsd: 0.004 },
    latencyMs: 120,
  });

  assert.equal(missingReward.trajectory.reward.status, "incomplete");
  assert.equal(missingReward.trajectory.reward.reason, "missing-live-eval-reward");
  assert.equal(missingReward.metrics.some((metric) => metric.name === "eval.score"), false);
});

test("invalid all-zero traceparent ids fail closed before telemetry export", () => {
  const runtime = createAiMethodTelemetryRuntime({
    spanIds: ["0000000000000600"],
    runKeyRef: "run-key://run-ai-method-1",
  });

  assert.throws(
    () =>
      runtime.invokeTrainableMethod({
        run: { ...run, traceparent: "00-00000000000000000000000000000000-0000000000000000-01" },
        method,
        request: baseRequest,
        response: baseResponse,
        model: { provider: "openai", name: "gpt-4o-mini" },
        tokenUsage: { prompt: 1, completion: 1 },
        latencyMs: 10,
      }),
    /all-zero trace or span ids/,
  );
});

test("shadow calls are exported but not double-counted into billable token cost", () => {
  const runtime = createAiMethodTelemetryRuntime({
    spanIds: ["0000000000000500", "0000000000000501"],
    runKeyRef: "run-key://run-ai-method-1",
  });

  runtime.invokeTrainableMethod({
    run,
    method: { ...method, candidateId: "champion-v2" },
    request: baseRequest,
    response: baseResponse,
    model: { provider: "openai", name: "gpt-4o-mini" },
    tokenUsage: { prompt: 90, completion: 30, costUsd: 0.018 },
    latencyMs: 200,
    liveEval: {
      rubricRef: "rubric://support/classifier@2.0.0",
      scores: { faithfulness: 0.94, piiSafe: 1 },
      thresholds: { faithfulness: 0.9, piiSafe: 1 },
      samples: 20,
      reward: 0.94,
    },
  });
  const shadow = runtime.invokeTrainableMethod({
    run: { ...run, traceparent: "00-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-ffffffffffffffff-01" },
    method: { ...method, candidateId: "shadow-v3" },
    request: baseRequest,
    response: baseResponse,
    model: { provider: "openai", name: "gpt-4o-mini" },
    tokenUsage: { prompt: 90, completion: 30, costUsd: 0.018 },
    latencyMs: 210,
    shadow: true,
    liveEval: {
      rubricRef: "rubric://support/classifier@2.0.0",
      scores: { faithfulness: 0.93, piiSafe: 1 },
      thresholds: { faithfulness: 0.9, piiSafe: 1 },
      samples: 20,
      reward: 0.93,
    },
  });

  assert.equal(shadow.spans[0].attributes["hobo.cost.counted"], false);
  assert.deepEqual(runtime.costSummary(), {
    billableTokens: 120,
    billableUsd: 0.018,
    shadowTokens: 120,
    shadowUsd: 0.018,
  });
});
