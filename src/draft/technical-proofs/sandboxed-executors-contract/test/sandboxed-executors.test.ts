import assert from "node:assert/strict";
import { test } from "vitest";

import { validateControlPlaneEvent } from "../../control-plane-event-schema-contract/src/control-plane-events.js";
import {
  CONTRACT_VERSION,
  createDevModeCredentialStub,
  createFixtureComponentizeJob,
  createFixtureIacPulumiJob,
  createSandboxEgressGuard,
  createSandboxedExecutor,
  selectSandboxBackend
} from "../src/sandboxed-executors.js";

test("acceptance: iac-pulumi apply streams exec.Started, exec.Output, exec.Succeeded to the log", async () => {
  const executor = createSandboxedExecutor({
    firecrackerAvailable: true,
    allowedEgress: [{ target: "pulumi://api.pulumi.com", declaration: "declared" }]
  });

  const result = await executor.run(createFixtureIacPulumiJob({ action: "apply" }), {
    tenant: "acme",
    credentialScope: "tenant:acme/resource:shop-api/job:iac-pulumi/action:apply"
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.sandbox.backend, "firecracker");
  assert.equal(result.sandbox.ambientCredentials, false);
  assert.deepEqual(result.events.map((event) => event.type), [
    "exec.Started",
    "exec.Output",
    "exec.Output",
    "exec.Output",
    "exec.Succeeded"
  ]);
  for (const event of result.events) {
    const validation = validateControlPlaneEvent(event);
    assert.equal(validation.ok, true, validation.errors.join("\n"));
  }
});

test("acceptance: iac-pulumi preview streams exec events through the sandbox", async () => {
  const executor = createSandboxedExecutor({ firecrackerAvailable: true });

  const result = await executor.run(
    createFixtureIacPulumiJob({
      action: "preview",
      output: ["pulumi preview complete"]
    }),
    { tenant: "acme" }
  );

  assert.equal(result.status, "succeeded");
  assert.match(result.events.at(1)?.data.line ?? "", /action=preview/);
  assert.equal(result.events.at(-1)?.type, "exec.Succeeded");
});

test("acceptance: componentize build streams exec events inside the sandbox", async () => {
  const executor = createSandboxedExecutor({ firecrackerAvailable: true });

  const result = await executor.run(createFixtureComponentizeJob(), { tenant: "acme" });

  assert.equal(result.status, "succeeded");
  assert.match(result.events.at(1)?.data.line ?? "", /job=componentize/);
  assert.match(result.outputs.imageRef, /^oci:\/\//);
});

test("acceptance: undeclared egress attempt is denied in the sandbox (NFR-007)", async () => {
  const executor = createSandboxedExecutor({
    firecrackerAvailable: true,
    allowedEgress: [{ target: "pulumi://api.pulumi.com", declaration: "declared" }]
  });

  const result = await executor.run(
    createFixtureIacPulumiJob({
      egressAttempts: [{ target: "https://attacker.example/exfiltrate", channel: "normal" }]
    }),
    { tenant: "acme" }
  );

  assert.equal(result.status, "failed");
  assert.equal(result.classification, "fatal");
  assert.match(result.reason, /undeclared egress denied/);
  assert.deepEqual(result.sandboxAudit, [
    {
      target: "https://attacker.example/exfiltrate",
      channel: "normal",
      outcome: "denied"
    }
  ]);
  assert.deepEqual(result.events.map((event) => event.type), [
    "exec.Started",
    "exec.Output",
    "exec.Output",
    "exec.Failed"
  ]);
});

test("selectSandboxBackend prefers firecracker and falls back to container", () => {
  assert.equal(selectSandboxBackend({ firecrackerAvailable: true }), "firecracker");
  assert.equal(selectSandboxBackend({ firecrackerAvailable: false }), "container");
});

test("dev-mode credential stub is scoped and non-ambient", () => {
  const credential = createDevModeCredentialStub({
    scope: "tenant:acme/resource:shop-api/job:iac-pulumi/action:apply"
  });

  assert.equal(credential.devMode, true);
  assert.equal(credential.ttlSeconds, 300);
  assert.match(credential.id, /^dev-stub-/);
});

test("sandbox egress guard denies targets outside the declared allowlist", () => {
  const guard = createSandboxEgressGuard([
    { target: "pulumi://api.pulumi.com", declaration: "declared" }
  ]);

  const denied = guard.evaluate({
    target: "https://metadata.internal/latest",
    channel: "normal"
  });
  const allowed = guard.evaluate({
    target: "pulumi://api.pulumi.com",
    channel: "normal"
  });

  assert.equal(denied.outcome, "denied");
  assert.equal(denied.eventType, "sandbox.EgressDenied");
  assert.equal(allowed.outcome, "allowed");
});

test("executor revokes dev-mode credential after success and failure", async () => {
  const broker = {
    active: 0,
    issue({ scope }) {
      this.active += 1;
      return createDevModeCredentialStub({ scope });
    },
    revoke() {
      if (this.active > 0) {
        this.active -= 1;
      }
    },
    activeCount() {
      return this.active;
    }
  };

  const executor = createSandboxedExecutor({ credentialBroker: broker });

  const success = await executor.run(createFixtureIacPulumiJob(), { tenant: "acme" });
  const failure = await executor.run(
    createFixtureIacPulumiJob({
      egressAttempts: [{ target: "https://evil.example", channel: "normal" }]
    }),
    { tenant: "acme" }
  );

  assert.equal(success.status, "succeeded");
  assert.equal(failure.status, "failed");
  assert.equal(broker.activeCount(), 0);
});

test("contract version is pinned for downstream promotion", () => {
  assert.equal(CONTRACT_VERSION, "sandboxed-executors-contract/v1");
});
