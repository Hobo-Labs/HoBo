import { type JsonObject } from "../src/json.js";
import assert from "node:assert/strict";
import { test } from "vitest";
import { validateControlPlaneEvent } from "../../control-plane-event-schema-contract/src/control-plane-events.js";
import {  createFixtureIacPulumiJob,
  createSandboxEgressGuard,
  createSandboxedExecutor
} from "../src/sandboxed-executors.js";

function assertValidControlPlaneEvents(events: Array<JsonObject>) {
  for (const event of events) {
    const validation = validateControlPlaneEvent(event);
    assert.equal(validation.ok, true, validation.errors.join("\n"));
  }
}

test("adversarial: container fallback is selected inside executor.run", async () => {
  const executor = createSandboxedExecutor({ firecrackerAvailable: false });

  const result = await executor.run(createFixtureIacPulumiJob(), { tenant: "acme" });

  assert.equal(result.status, "succeeded");
  assert.equal(result.sandbox.backend, "container");
  assert.match(result.events.at(1)?.data.line ?? "", /sandbox=container/);
});

test("adversarial: undeclared egress failure events validate against control-plane schema", async () => {
  const executor = createSandboxedExecutor({
    allowedEgress: [{ target: "pulumi://api.pulumi.com", declaration: "declared" }]
  });

  const result = await executor.run(
    createFixtureIacPulumiJob({
      egressAttempts: [{ target: "https://attacker.example/exfiltrate", channel: "normal" }]
    }),
    { tenant: "acme" }
  );

  assert.equal(result.status, "failed");
  assertValidControlPlaneEvents(result.events);
});

test("adversarial: declared egress to an allowed target completes successfully", async () => {
  const executor = createSandboxedExecutor({
    allowedEgress: [{ target: "pulumi://api.pulumi.com", declaration: "declared" }]
  });

  const result = await executor.run(
    createFixtureIacPulumiJob({
      egressAttempts: [{ target: "pulumi://api.pulumi.com", channel: "normal" }]
    }),
    { tenant: "acme" }
  );

  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.sandboxAudit, [
    {
      target: "pulumi://api.pulumi.com",
      channel: "normal",
      outcome: "allowed"
    }
  ]);
});

test("adversarial: covert channel on an allowed target is audited but not denied", () => {
  const guard = createSandboxEgressGuard([
    { target: "pulumi://api.pulumi.com", declaration: "declared" }
  ]);

  const verdict = guard.evaluate({
    target: "pulumi://api.pulumi.com",
    channel: "covert"
  });

  assert.equal(verdict.outcome, "allowed-with-audit");
  assert.equal(verdict.eventType, "sandbox.ScopedEgressObserved");
});
