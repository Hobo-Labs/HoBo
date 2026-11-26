import assert from "node:assert/strict";
import { test } from "vitest";

import {
  buildSignedReceiptFixture,
  consumeResolutionReceipt,
  rejectAdminReceiptMutation,
  resolveGatekeeperHandoff,
} from "../src/yard-receipt-consumption.ts";

test("Yard accepts a signed Resolution Receipt as broker authority without re-resolving", () => {
  let brokerResolverCalls = 0;
  const receipt = buildSignedReceiptFixture();

  const planningInput = consumeResolutionReceipt({
    receipt,
    now: new Date("2026-06-29T21:00:00.000Z"),
    yardProtocolVersion: "yard-receipt-consumption/v1",
    brokerResolver: () => {
      brokerResolverCalls += 1;
      throw new Error("broker resolver must not be invoked by Yard receipt consumption");
    },
  });

  assert.equal(brokerResolverCalls, 0);
  assert.equal(planningInput.source, "resolution-receipt");
  assert.equal(planningInput.receiptId, "receipt-shop-prod-001");
  assert.equal(planningInput.brokerAuthority, "meta-cloud-broker");
  assert.deepEqual(
    planningInput.resourcePlans.map((plan) => plan.resourceId),
    ["cache", "api"],
  );
});

test("missing, tampered, stale, or incompatible receipts fail closed", () => {
  assert.throws(
    () =>
      consumeResolutionReceipt({
        receipt: undefined,
        now: new Date("2026-06-29T21:00:00.000Z"),
        yardProtocolVersion: "yard-receipt-consumption/v1",
        brokerResolver: () => buildSignedReceiptFixture(),
      }),
    /receipt-required:no-broker-reresolve/,
  );

  const tampered = buildSignedReceiptFixture({
    resourcePlans: [
      { resourceId: "cache", provider: "provider.beta", action: "provision" },
      { resourceId: "api", provider: "provider.alpha", action: "deploy" },
    ],
  });
  tampered.handoffFacts.resourcePlans[0].provider = "provider.evil";
  assert.throws(
    () =>
      consumeResolutionReceipt({
        receipt: tampered,
        now: new Date("2026-06-29T21:00:00.000Z"),
        yardProtocolVersion: "yard-receipt-consumption/v1",
      }),
    /receipt-integrity-failed/,
  );

  assert.throws(
    () =>
      consumeResolutionReceipt({
        receipt: buildSignedReceiptFixture({ expiresAt: "2026-06-29T20:59:59.999Z" }),
        now: new Date("2026-06-29T21:00:00.000Z"),
        yardProtocolVersion: "yard-receipt-consumption/v1",
      }),
    /receipt-stale/,
  );

  assert.throws(
    () =>
      consumeResolutionReceipt({
        receipt: buildSignedReceiptFixture({ protocolVersion: "yard-receipt-consumption/v2" }),
        now: new Date("2026-06-29T21:00:00.000Z"),
        yardProtocolVersion: "yard-receipt-consumption/v1",
      }),
    /receipt-incompatible/,
  );
});

test("Yard-local planning is receipt consumption, not hosted broker authority", () => {
  const receipt = buildSignedReceiptFixture();
  const planningInput = consumeResolutionReceipt({
    receipt,
    now: new Date("2026-06-29T21:00:00.000Z"),
    yardProtocolVersion: "yard-receipt-consumption/v1",
  });

  assert.equal(planningInput.planningAuthority, "yard-control-plane");
  assert.equal(planningInput.resolutionAuthority, "meta-cloud-broker");
  assert.equal(planningInput.mayRecomputeBrokerMapping, false);
  assert.match(planningInput.auditEvent.type, /ReceiptConsumedForPlanning/);
});

test("admin controls cannot mutate issued receipt contents", () => {
  const result = rejectAdminReceiptMutation({
    actor: "admin-console",
    receipt: buildSignedReceiptFixture(),
    patch: { handoffFacts: { resourcePlans: [] } },
  });

  assert.deepEqual(result, {
    allowed: false,
    reason: "admin-mutation-refused:new-receipt-required",
  });
});

test("Gatekeeper can block or add obligations but cannot rewrite broker receipt mappings", () => {
  const planningInput = consumeResolutionReceipt({
    receipt: buildSignedReceiptFixture(),
    now: new Date("2026-06-29T21:00:00.000Z"),
    yardProtocolVersion: "yard-receipt-consumption/v1",
  });

  assert.deepEqual(
    resolveGatekeeperHandoff({
      planningInput,
      decision: {
        effect: "allow-with-obligation",
        obligations: ["require-canary"],
      },
    }),
    {
      effect: "allow-with-obligation",
      obligations: ["require-canary"],
      receiptId: "receipt-shop-prod-001",
      resourcePlans: planningInput.resourcePlans,
    },
  );

  assert.throws(
    () =>
      resolveGatekeeperHandoff({
        planningInput,
        decision: {
          effect: "allow",
          rewriteResourcePlans: [{ resourceId: "api", provider: "provider.evil", action: "deploy" }],
        },
      }),
    /gatekeeper-rewrite-refused/,
  );
});
