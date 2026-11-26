import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  evaluateCanDeploy,
  replayCompatibilityDecision,
  runCanDeployCommand,
} from "../src/compatibility-gate.js";

describe("can-deploy compatibility matrix", () => {
  it("blocks a producer contract that removes a field a running consumer still requires", () => {
    const decision = evaluateCanDeploy({
      target: "prod",
      camp: { enforcementMode: "strict" },
      proposedSet: {
        producers: [
          {
            component: "api",
            version: "1.8.0",
            channel: "order-events/order.created",
            contractVersion: "v3",
            provides: ["orderId"],
          },
        ],
      },
      eventLog: [
        {
          type: "deployment.Running",
          target: "prod",
          component: "worker",
          version: "1.4.2",
          consumes: [
            {
              producer: "api",
              channel: "order-events/order.created",
              contractVersion: "v2",
              requiredFields: ["orderId", "tenantId"],
            },
          ],
        },
      ],
    });

    assert.equal(decision.ok, false);
    assert.equal(decision.events[0].type, "compat.GateFailed");
    assert.equal(decision.enforcementMode, "strict");
    assert.deepEqual(decision.failures[0], {
      reason: "producer-broke-consumer",
      channel: "order-events/order.created",
      producer: "api@1.8.0",
      proposedContractVersion: "v3",
      consumer: "worker@1.4.2",
      runningContractVersion: "v2",
      missingFields: ["tenantId"],
    });
    assert.match(decision.summary, /api@1\.8\.0 publishes order-events\/order\.created v3/);
    assert.match(decision.summary, /worker@1\.4\.2 .*requires tenantId/);
    assert.ok(decision.suggestedFixes.includes("dual-publish tenantId during a migration window"));
    assert.ok(decision.suggestedFixes.includes("deploy worker@1.5.0 first"));
    assert.deepEqual(replayCompatibilityDecision(decision.events), decision);
  });

  it("passes compatible additive producer changes and emits a replayable GatePassed event", () => {
    const decision = evaluateCanDeploy({
      target: "prod",
      camp: { enforcementMode: "strict" },
      proposedSet: {
        producers: [
          {
            component: "api",
            version: "1.9.0",
            channel: "order-events/order.created",
            contractVersion: "v3",
            provides: ["orderId", "tenantId", "discountCode"],
          },
        ],
      },
      eventLog: [
        {
          type: "deployment.Running",
          target: "prod",
          component: "worker",
          version: "1.4.2",
          consumes: [
            {
              producer: "api",
              channel: "order-events/order.created",
              contractVersion: "v2",
              requiredFields: ["orderId", "tenantId"],
            },
          ],
        },
      ],
    });

    assert.equal(decision.ok, true);
    assert.equal(decision.events[0].type, "compat.GatePassed");
    assert.equal(decision.failures.length, 0);
    assert.equal(decision.matrix[0].compatible, true);
    assert.deepEqual(decision.matrix[0].providedFields, ["discountCode", "orderId", "tenantId"]);
    assert.deepEqual(replayCompatibilityDecision(decision.events), decision);
  });

  it("fails closed when the target has no running-version facts", () => {
    const decision = evaluateCanDeploy({
      target: "prod",
      camp: { enforcementMode: "strict" },
      proposedSet: {
        producers: [
          {
            component: "api",
            version: "1.9.0",
            channel: "order-events/order.created",
            contractVersion: "v3",
            provides: ["orderId", "tenantId"],
          },
        ],
      },
      eventLog: [],
    });

    assert.equal(decision.ok, false);
    assert.equal(decision.events[0].type, "compat.GateFailed");
    assert.deepEqual(decision.failures, [
      {
        reason: "unknown-running-versions",
        target: "prod",
      },
    ]);
    assert.match(decision.summary, /unknown running versions/);
  });

  it("blocks a proposed consumer that requires a field the running producer does not publish", () => {
    const decision = evaluateCanDeploy({
      target: "prod",
      camp: { enforcementMode: "strict" },
      proposedSet: {
        consumers: [
          {
            component: "worker",
            version: "1.5.0",
            producer: "api",
            channel: "order-events/order.created",
            contractVersion: "v3",
            requires: ["orderId", "tenantId", "couponCode"],
          },
        ],
      },
      eventLog: [
        {
          type: "deployment.Running",
          target: "prod",
          component: "api",
          version: "1.8.0",
          produces: [
            {
              channel: "order-events/order.created",
              contractVersion: "v2",
              providedFields: ["orderId", "tenantId"],
            },
          ],
        },
      ],
    });

    assert.equal(decision.ok, false);
    assert.deepEqual(decision.failures[0], {
      reason: "consumer-over-specified",
      channel: "order-events/order.created",
      producer: "api@1.8.0",
      runningContractVersion: "v2",
      consumer: "worker@1.5.0",
      proposedContractVersion: "v3",
      missingFields: ["couponCode"],
    });
    assert.match(decision.summary, /worker@1\.5\.0 requires couponCode/);
    assert.ok(decision.suggestedFixes.includes("deploy api@1.9.0 first"));
    assert.ok(decision.suggestedFixes.includes("loosen worker@1.5.0 to tolerate missing couponCode"));
  });

  it("records record-and-verify mode without weakening strict compatibility semantics", () => {
    const decision = evaluateCanDeploy({
      target: "edge",
      camp: { enforcementMode: "record-and-verify" },
      proposedSet: {
        producers: [
          {
            component: "api",
            version: "1.8.0",
            channel: "order-events/order.created",
            contractVersion: "v3",
            provides: ["orderId"],
          },
        ],
      },
      eventLog: [
        {
          type: "deployment.Running",
          target: "edge",
          component: "worker",
          version: "1.4.2",
          consumes: [
            {
              producer: "api",
              channel: "order-events/order.created",
              contractVersion: "v2",
              requiredFields: ["orderId", "tenantId"],
            },
          ],
        },
      ],
    });

    assert.equal(decision.ok, false);
    assert.equal(decision.enforcementMode, "record-and-verify");
    assert.equal(decision.events[0].enforcementMode, "record-and-verify");
    assert.equal(decision.failures[0].reason, "producer-broke-consumer");
  });

  it("returns a structured can-deploy decision for a target entry point", () => {
    const result = runCanDeployCommand(["--target", "prod"], {
      camps: {
        prod: { enforcementMode: "strict" },
      },
      proposedSet: {
        producers: [
          {
            component: "api",
            version: "1.9.0",
            channel: "order-events/order.created",
            contractVersion: "v3",
            provides: ["orderId", "tenantId"],
          },
        ],
      },
      eventLog: [
        {
          type: "deployment.Running",
          target: "prod",
          component: "worker",
          version: "1.4.2",
          consumes: [
            {
              producer: "api",
              channel: "order-events/order.created",
              contractVersion: "v2",
              requiredFields: ["orderId", "tenantId"],
            },
          ],
        },
      ],
    });

    assert.equal(result.command, "hobo can-deploy");
    assert.equal(result.target, "prod");
    assert.equal(result.exitCode, 0);
    assert.equal(result.decision.ok, true);
    assert.equal(result.decision.events[0].type, "compat.GatePassed");
  });
});
