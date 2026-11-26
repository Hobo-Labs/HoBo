import assert from "node:assert/strict";
import { test } from "vitest";

import { validateControlPlaneEvent } from "../../control-plane-event-schema-contract/src/control-plane-events.js";
import {
  createFixtureIacProgram,
  createFlakyOutputTransport,
  createInProcessExecutor,
  createRecordingRelayTransport,
  createStubTokenBroker
} from "../src/executor-skeleton.js";

test("fake in-process Executor streams exec.Started to exec.Output to exec.Succeeded with captured outputs", async () => {
  const tokenBroker = createStubTokenBroker();
  const executor = createInProcessExecutor({
    tokenBroker,
    concurrencyLimit: 1
  });

  const result = await executor.dispatch(createFixtureIacProgram(), {
    resourceId: "assets",
    action: "apply",
    credentialScope: "tenant:acme/resource:assets/provider:local/action:apply"
  });

  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.events.map((event) => event.type), [
    "exec.Started",
    "exec.Output",
    "exec.Output",
    "exec.Succeeded"
  ]);
  assert.deepEqual(result.outputs, {
    endpoint: "memory://assets",
    resourceId: "assets"
  });
  for (const event of result.events) {
    const validation = validateControlPlaneEvent(event);
    assert.equal(validation.ok, true, validation.errors.join("\n"));
  }
  assert.deepEqual(tokenBroker.auditLog.map((entry) => entry.type), ["issued", "revoked"]);
  assert.equal(tokenBroker.activeTokenCount(), 0);
});

test("failing programs emit exec.Failed with retryable or fatal classification", async () => {
  const tokenBroker = createStubTokenBroker();
  const executor = createInProcessExecutor({ tokenBroker });

  const retryable = await executor.dispatch(
    createFixtureIacProgram({
      id: "iac-assets-timeout",
      failure: { classification: "retryable", reason: "provider timeout" }
    }),
    {
      resourceId: "assets",
      action: "apply",
      credentialScope: "tenant:acme/resource:assets/provider:local/action:apply"
    }
  );
  const fatal = await executor.dispatch(
    createFixtureIacProgram({
      id: "iac-assets-invalid",
      failure: { classification: "fatal", reason: "invalid IacProgram" }
    }),
    {
      resourceId: "assets",
      action: "apply",
      credentialScope: "tenant:acme/resource:assets/provider:local/action:apply"
    }
  );

  assert.equal(retryable.status, "failed");
  assert.equal(retryable.classification, "retryable");
  assert.equal(retryable.events.at(-1).type, "exec.Failed");
  assert.equal(retryable.events.at(-1).data.reason, "retryable: provider timeout");

  assert.equal(fatal.status, "failed");
  assert.equal(fatal.classification, "fatal");
  assert.equal(fatal.events.at(-1).data.reason, "fatal: invalid IacProgram");
  for (const event of [...retryable.events, ...fatal.events]) {
    const validation = validateControlPlaneEvent(event);
    assert.equal(validation.ok, true, validation.errors.join("\n"));
  }
  assert.equal(tokenBroker.activeTokenCount(), 0);
});

test("concurrency bound rejects over-limit work before a second token is issued", async () => {
  const tokenBroker = createStubTokenBroker();
  const executor = createInProcessExecutor({
    tokenBroker,
    concurrencyLimit: 1
  });
  const gate = createDeferred();

  const firstRun = executor.dispatch(createFixtureIacProgram({ waitFor: gate.promise }), {
    resourceId: "assets",
    action: "apply",
    credentialScope: "tenant:acme/resource:assets/provider:local/action:apply"
  });

  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    () =>
      executor.dispatch(createFixtureIacProgram({ id: "iac-api-apply", resourceId: "api" }), {
        resourceId: "api",
        action: "apply",
        credentialScope: "tenant:acme/resource:api/provider:local/action:apply"
      }),
    /concurrency limit exceeded/
  );
  assert.deepEqual(tokenBroker.auditLog.map((entry) => entry.type), ["issued"]);

  gate.resolve();
  const result = await firstRun;
  assert.equal(result.status, "succeeded");
  assert.deepEqual(tokenBroker.auditLog.map((entry) => entry.type), ["issued", "revoked"]);
});

test("token expiry mid-run fails closed and revokes the scoped token", async () => {
  const tokenBroker = createStubTokenBroker({ expireAfterOutputCount: 1 });
  const executor = createInProcessExecutor({ tokenBroker });

  const result = await executor.dispatch(createFixtureIacProgram(), {
    resourceId: "assets",
    action: "apply",
    credentialScope: "tenant:acme/resource:assets/provider:local/action:apply"
  });

  assert.equal(result.status, "failed");
  assert.equal(result.classification, "retryable");
  assert.equal(result.reason, "retryable: token expired mid-run");
  assert.equal(result.events.at(-1).type, "exec.Failed");
  assert.equal(result.events.at(-1).data.reason, "retryable: token expired mid-run");
  assert.equal(tokenBroker.activeTokenCount(), 0);
  assert.deepEqual(tokenBroker.auditLog.map((entry) => entry.type), ["issued", "expired", "revoked"]);
});

test("severed output stream during apply is ambiguous and requires reconciliation", async () => {
  const tokenBroker = createStubTokenBroker();
  const executor = createInProcessExecutor({
    tokenBroker,
    outputTransport: createFlakyOutputTransport({ failAfterLines: 1 })
  });

  const result = await executor.dispatch(createFixtureIacProgram(), {
    resourceId: "assets",
    action: "apply",
    credentialScope: "tenant:acme/resource:assets/provider:local/action:apply"
  });

  assert.equal(result.status, "failed");
  assert.equal(result.classification, "ambiguous");
  assert.equal(result.reconcileRequired, true);
  assert.equal(result.events.at(-1).type, "exec.Failed");
  assert.equal(
    result.events.at(-1).data.reason,
    "ambiguous: output stream severed mid-apply; reconcile required"
  );
  assert.deepEqual(result.events.map((event) => event.type), ["exec.Started", "exec.Output", "exec.Failed"]);
  assert.equal(tokenBroker.activeTokenCount(), 0);
});

test("executor crash after start emits exec.Failed and leaves no orphaned credential", async () => {
  const tokenBroker = createStubTokenBroker();
  const executor = createInProcessExecutor({ tokenBroker });

  const result = await executor.dispatch(createFixtureIacProgram({ crashAfterStarted: true }), {
    resourceId: "assets",
    action: "apply",
    credentialScope: "tenant:acme/resource:assets/provider:local/action:apply"
  });

  assert.equal(result.status, "failed");
  assert.equal(result.classification, "fatal");
  assert.equal(result.reason, "fatal: executor crash before completion");
  assert.deepEqual(result.events.map((event) => event.type), ["exec.Started", "exec.Failed"]);
  assert.equal(tokenBroker.activeTokenCount(), 0);
  assert.deepEqual(tokenBroker.auditLog.map((entry) => entry.type), ["issued", "revoked"]);
});

test("relay transport seam records work and result routing without executing provider logic", async () => {
  const tokenBroker = createStubTokenBroker();
  const relayTransport = createRecordingRelayTransport({ targetId: "relay-private-network" });
  const executor = createInProcessExecutor({ tokenBroker, relayTransport });

  const result = await executor.dispatch(createFixtureIacProgram(), {
    resourceId: "assets",
    action: "apply",
    credentialScope: "tenant:acme/resource:assets/provider:local/action:apply"
  });

  assert.equal(result.status, "succeeded");
  assert.deepEqual(relayTransport.auditLog, [
    {
      type: "work-routed",
      targetId: "relay-private-network",
      execId: result.execId,
      resourceId: "assets",
      provider: "local"
    },
    {
      type: "result-routed",
      targetId: "relay-private-network",
      execId: result.execId,
      status: "succeeded"
    }
  ]);
});

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
