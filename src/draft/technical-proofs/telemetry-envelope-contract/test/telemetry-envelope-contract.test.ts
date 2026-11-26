import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  TELEMETRY_ENVELOPE_SCHEMA_VERSION,
  fromCloudEvent,
  fromOcsfEvent,
  fromOtlpSpan,
  parseTelemetryEnvelope,
  serializeTelemetryEnvelope,
  toCloudEvent,
  toOcsfEvent,
  toOtlpSpan,
  validateEventNamespaceCatalog,
} from "../src/telemetry-envelope-contract.js";

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

const policyDecisionEnvelope = {
  schemaVersion: TELEMETRY_ENVELOPE_SCHEMA_VERSION,
  id: "evt-policy-0001",
  type: "policy.Decided",
  streamId: "yard/prod/policy/decisions",
  seq: 42,
  ts: "2026-06-01T12:00:00.000Z",
  tenant: "tenant-a",
  actor: "policy-engine",
  correlationId: "corr-deploy-0001",
  causationId: "cmd-promote-0001",
  data: {
    principalRef: "spiffe://tenant-a/bindle/shop/resource/web",
    action: "deploy.promote",
    resource: "camp/prod/bindle/shop",
    decision: "deny",
    reason: "deny-ceiling",
  },
  meta: {
    traceparent,
    tracestate: "rojo=00f067aa0ba902b7",
    idempotencyKey: "idem-policy-0001",
  },
};

describe("telemetry envelope boundary contract", () => {
  it("round-trips an envelope through OTLP, CloudEvents, and OCSF projections with no field loss", () => {
    const envelope = parseTelemetryEnvelope(policyDecisionEnvelope);

    assert.deepEqual(fromOtlpSpan(toOtlpSpan(envelope)), envelope);
    assert.deepEqual(fromCloudEvent(toCloudEvent(envelope)), envelope);
    assert.deepEqual(fromOcsfEvent(toOcsfEvent(envelope)), envelope);
    assert.equal(JSON.parse(serializeTelemetryEnvelope(envelope)).meta.traceparent, traceparent);
  });

  it("pins W3C traceparent propagation into OTLP spans and CloudEvents extensions", () => {
    const span = toOtlpSpan(policyDecisionEnvelope);
    const cloudEvent = toCloudEvent(policyDecisionEnvelope);

    assert.equal(span.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
    assert.equal(span.spanId, "00f067aa0ba902b7");
    assert.equal(span.attributes["hobo.traceparent"], traceparent);
    assert.equal(cloudEvent.traceparent, traceparent);
    assert.equal(cloudEvent.hobotraceparent, traceparent);
  });

  it("asserts schema version and fails compatibility on breaking envelope changes", () => {
    assert.throws(
      () => parseTelemetryEnvelope({ ...policyDecisionEnvelope, schemaVersion: "hobo.telemetry-envelope/v2" }),
      /schemaVersion/,
    );

    assert.throws(
      () => parseTelemetryEnvelope({ ...policyDecisionEnvelope, seq: undefined }),
      /seq/,
    );
  });

  it("rejects malformed traceparent and only synthesizes a root trace when explicitly requested", () => {
    assert.throws(
      () =>
        parseTelemetryEnvelope({
          ...policyDecisionEnvelope,
          meta: { ...policyDecisionEnvelope.meta, traceparent: "bad-trace" },
        }),
      /traceparent/,
    );

    assert.throws(
      () => parseTelemetryEnvelope({ ...policyDecisionEnvelope, meta: {} }),
      /traceparent/,
    );

    const synthesized = parseTelemetryEnvelope(
      { ...policyDecisionEnvelope, meta: {} },
      { missingTraceparent: "synthesize-root" },
    );

    assert.match(synthesized.meta.traceparent, /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
    assert.equal(synthesized.meta.traceparentSynthetic, true);
  });

  it("keeps event-family names collision-proof at export boundaries", () => {
    validateEventNamespaceCatalog(["run.Started", "actor.Started", "saga.Started"]);

    assert.throws(
      () => validateEventNamespaceCatalog(["run.Started", "run.Started"]),
      /duplicate event type/,
    );
    assert.throws(
      () => parseTelemetryEnvelope({ ...policyDecisionEnvelope, type: "unknown.Decided" }),
      /unsupported event family/,
    );

    const exportedTypes = ["run.Started", "actor.Started"].map((type) =>
      toCloudEvent({ ...policyDecisionEnvelope, type }).type,
    );
    assert.deepEqual(exportedTypes, ["run.Started", "actor.Started"]);
  });

  it("rejects CloudEvents required-attribute gaps", () => {
    const cloudEvent = toCloudEvent(policyDecisionEnvelope);
    delete cloudEvent.source;

    assert.throws(() => fromCloudEvent(cloudEvent), /source/);
  });

  it("does not drop security-relevant OCSF authorization fields", () => {
    const ocsf = toOcsfEvent(policyDecisionEnvelope);

    assert.equal(ocsf.class_name, "Authorization");
    assert.equal(ocsf.actor.user.uid, policyDecisionEnvelope.data.principalRef);
    assert.equal(ocsf.activity_name, policyDecisionEnvelope.data.action);
    assert.equal(ocsf.resource.uid, policyDecisionEnvelope.data.resource);
    assert.equal(ocsf.status_detail, policyDecisionEnvelope.data.decision);

    assert.throws(
      () =>
        toOcsfEvent({
          ...policyDecisionEnvelope,
          data: {
            action: "deploy.promote",
            resource: "camp/prod/bindle/shop",
            decision: "deny",
          },
        }),
      /principalRef/,
    );
  });
});
