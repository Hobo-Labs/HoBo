import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  buildSignedResolutionReceiptFixture,
  createReceiptVerificationContext,
  type ReceiptRejectionReason,
  verifyResolutionReceipt,
} from "../src/broker-receipt-integrity.ts";

test("valid Resolution Receipt fixtures remain accepted with customer-safe debug evidence", () => {
  const context = createReceiptVerificationContext();
  const receipt = buildSignedResolutionReceiptFixture(context);

  const result = verifyResolutionReceipt({
    context,
    receipt,
    now: new Date("2026-06-30T20:30:00.000Z"),
    expected: {
      tenantId: "tenant-alpha",
      environmentId: "prod-us",
      manifestDigest: "sha256:manifest-shop-prod",
      brokerSnapshotDigest: "sha256:broker-snapshot-prod-001",
      minSchemaVersion: 2,
    },
  });

  assert.equal(result.kind, "accepted");
  assert.equal(result.receiptId, "receipt-shop-prod-001");
  assert.equal(result.authority, "meta-cloud-broker");
  assert.equal(result.gatekeeperBoundary, "policy-after-receipt");
  assert.deepEqual(result.debugEvidence, {
    receiptId: "receipt-shop-prod-001",
    tenantId: "tenant-alpha",
    environmentId: "prod-us",
    manifestDigest: "sha256:manifest-shop-prod",
    brokerSnapshotDigest: "sha256:broker-snapshot-prod-001",
    supportSafe: true,
  });
  assert.equal(JSON.stringify(result).includes("PRIVATE KEY"), false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("tampered, replayed, downgraded, and expired receipts fail closed", () => {
  const context = createReceiptVerificationContext();
  const expected = validExpectation();

  const validReceipt = buildSignedResolutionReceiptFixture(context);
  assertRejected(
    verifyResolutionReceipt({
      context,
      receipt: {
        ...validReceipt,
        payload: { ...validReceipt.payload, manifestDigest: "sha256:manifest-tampered" },
      },
      now: fixedNow(),
      expected,
    }),
    "receipt-integrity-failed",
  );

  assertRejected(
    verifyResolutionReceipt({
      context,
      receipt: validReceipt,
      now: fixedNow(),
      expected,
      seenReceiptIds: new Set([validReceipt.payload.receiptId]),
    }),
    "receipt-replay-refused",
  );

  assertRejected(
    verifyResolutionReceipt({
      context,
      receipt: buildSignedResolutionReceiptFixture(context, { schemaVersion: 1 }),
      now: fixedNow(),
      expected,
    }),
    "receipt-downgrade-refused",
  );

  assertRejected(
    verifyResolutionReceipt({
      context,
      receipt: buildSignedResolutionReceiptFixture(context, {
        expiresAt: "2026-06-30T20:29:59.999Z",
      }),
      now: fixedNow(),
      expected,
    }),
    "receipt-expired",
  );
});

test("receipt reuse across tenant, environment, broker snapshot, or manifest digest is refused", () => {
  const context = createReceiptVerificationContext();
  const expected = validExpectation();

  assertRejected(
    verifyResolutionReceipt({
      context,
      receipt: buildSignedResolutionReceiptFixture(context, { tenantId: "tenant-beta" }),
      now: fixedNow(),
      expected,
    }),
    "receipt-tenant-mismatch",
  );

  assertRejected(
    verifyResolutionReceipt({
      context,
      receipt: buildSignedResolutionReceiptFixture(context, { environmentId: "staging-us" }),
      now: fixedNow(),
      expected,
    }),
    "receipt-environment-mismatch",
  );

  assertRejected(
    verifyResolutionReceipt({
      context,
      receipt: buildSignedResolutionReceiptFixture(context, {
        brokerSnapshotDigest: "sha256:broker-snapshot-stale",
      }),
      now: fixedNow(),
      expected,
    }),
    "receipt-snapshot-mismatch",
  );

  assertRejected(
    verifyResolutionReceipt({
      context,
      receipt: buildSignedResolutionReceiptFixture(context, {
        manifestDigest: "sha256:manifest-other",
      }),
      now: fixedNow(),
      expected,
    }),
    "receipt-manifest-mismatch",
  );
});

test("Gatekeeper apply-time policy remains outside broker receipt integrity", () => {
  const context = createReceiptVerificationContext();

  assertRejected(
    verifyResolutionReceipt({
      context,
      receipt: buildSignedResolutionReceiptFixture(context, {
        // SAFETY: `gatekeeperBoundary: "policy-before-receipt" as never,` is required at this I/O or test boundary.
        gatekeeperBoundary: "policy-before-receipt" as never,
      }),
      now: fixedNow(),
      expected: validExpectation(),
    }),
    "receipt-gatekeeper-boundary-invalid",
  );
});

test("architecture evidence pins protobuf, CUE, and Pact receipt-integrity boundaries", () => {
  const architecture = readFileSync(new URL("../ADR.md", import.meta.url), "utf8");
  const proto = readFileSync(
    new URL("../architecture/broker_receipt_integrity.proto", import.meta.url),
    "utf8",
  );
  const cue = readFileSync(
    new URL("../architecture/broker_receipt_integrity.cue", import.meta.url),
    "utf8",
  );
  const pact = JSON.parse(
    readFileSync(
      new URL("../architecture/pacts/broker_receipt_integrity.pact.json", import.meta.url),
      "utf8",
    ),
  );

  for (const typeName of [
    "ResolutionReceipt",
    "ReceiptExpectation",
    "SupportSafeReceiptEvidence",
    "ReceiptRejectionCode",
  ]) {
    assert.match(proto, new RegExp(`(?:message|enum) ${typeName}`));
    assert.match(cue, new RegExp(`#${typeName}:`));
  }
  for (const refusalCode of [
    "receipt-integrity-failed",
    "receipt-replay-refused",
    "receipt-downgrade-refused",
    "receipt-tenant-mismatch",
    "receipt-environment-mismatch",
    "receipt-snapshot-mismatch",
    "receipt-manifest-mismatch",
  ]) {
    assert.match(cue, new RegExp(refusalCode));
  }

  assert.equal(pact.consumer.name, "YardReceiptVerifier");
  assert.equal(pact.provider.name, "MetaCloudBrokerReceiptAuthority");
  assert.ok(pact.interactions.length >= 2);
  assert.match(architecture, /parse, don't validate/i);
  assert.match(architecture, /Protobuf/i);
  assert.match(architecture, /CUE/i);
  assert.match(architecture, /PACT/i);
  assert.match(architecture, /Gatekeeper/i);
});

function assertRejected(
  result: ReturnType<typeof verifyResolutionReceipt>,
  code: ReceiptRejectionReason["code"],
) {
  assert.equal(result.kind, "rejected");
  assert.equal(result.reason.code, code);
  assert.equal(result.reason.supportSafe, true);
  assert.equal(result.debugEvidence.supportSafe, true);
  assert.equal("receipt" in result, false);
  assert.equal("signature" in result, false);
  assert.equal("handoff" in result, false);
  assert.equal(JSON.stringify(result).includes("PRIVATE KEY"), false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
}

function fixedNow() {
  return new Date("2026-06-30T20:30:00.000Z");
}

function validExpectation() {
  return {
    tenantId: "tenant-alpha",
    environmentId: "prod-us",
    manifestDigest: "sha256:manifest-shop-prod",
    brokerSnapshotDigest: "sha256:broker-snapshot-prod-001",
    minSchemaVersion: 2,
  };
}
