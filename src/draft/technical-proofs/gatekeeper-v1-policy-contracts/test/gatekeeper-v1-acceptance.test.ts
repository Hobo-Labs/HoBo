import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  allowWithCanaryFixture,
  producerConsumerSkewFixture,
  unsafePolicyDenyFixture,
} from "../src/fixtures.js";
import {
  replayDeployVerification,
  verifyDeployAtPoint,
} from "../src/gatekeeper-v1.js";

describe("Gatekeeper v1 deploy-point acceptance (HOBO-624)", () => {
  it("emits compat.GateFailed for seeded producer/consumer skew", async () => {
    const fixtures = producerConsumerSkewFixture();
    const result = await verifyDeployAtPoint({ fixtures });

    assert.equal(result.deployable, false);
    assert.equal(result.compatibility.ok, false);
    assert.equal(result.compatibility.events.at(-1)?.type, "compat.GateFailed");
    assert.match(result.compatibility.summary ?? "", /tenantId/);
    assert.equal(result.gatekeeper.failures[0]?.gate, "contracts");
    assert.ok(result.events.some((event) => event.type === "compat.GateFailed"));
    assert.deepEqual(replayDeployVerification(result.events).deployable, false);
  });

  it("blocks unsafe change with explainable event-sourced policy reason", async () => {
    const fixtures = unsafePolicyDenyFixture();
    const result = await verifyDeployAtPoint({ fixtures });

    assert.equal(result.deployable, false);
    assert.equal(result.policyDecision.effect, "deny");
    assert.match(result.policyDecision.reason, /auth middleware/i);
    assert.ok(result.events.some((event) => event.type === "policy.Decided"));
    assert.equal(result.gatekeeper.failures[0]?.gate, "policy");
    assert.match(result.gatekeeper.failures[0]?.reason ?? "", /auth middleware/i);

    const replayed = replayDeployVerification(result.events);
    assert.equal(replayed.policyDecision.effect, "deny");
    assert.equal(replayed.deployable, false);
  });

  it("persists allow-but-require-canary obligation from policy decision", async () => {
    const fixtures = allowWithCanaryFixture();
    const result = await verifyDeployAtPoint({ fixtures });

    assert.equal(result.policyDecision.effect, "require-approval");
    assert.ok(result.events.some((event) => event.type === "policy.ObligationCreated"));

    const canary = result.obligations.find((obligation) => obligation.kind === "require-canary");
    assert.ok(canary, "expected require-canary obligation");
    assert.equal(canary.status, "pending");
    assert.equal(canary.effect.kind, "rollout-canary");

    const replayed = replayDeployVerification(result.events);
    const replayedCanary = replayed.obligations.find((obligation) => obligation.kind === "require-canary");
    assert.equal(replayedCanary?.status, "pending");
  });
});
