import assert from "node:assert/strict";
import { test } from "vitest";

import {
  applyResourceSlice,
  compensateNoGoDeployment,
  createIacBackendHarness,
  destroyPartialSlice,
  inspectStack
} from "../src/iac-partial-apply-compensation.js";

const backendNames = ["iac-pulumi", "iac-opentofu"];

const program = [
  resource("network"),
  resource("database"),
  resource("api")
];

for (const backendName of backendNames) {
  test(`${backendName}: mid-program apply failure leaves state that destroy cleans exactly`, () => {
    const backend = createIacBackendHarness({ backendName });
    applyResourceSlice({
      backend,
      stackKey: "tenant-a/deploy-214/sibling",
      program: [resource("sibling-cache")]
    });

    const failed = applyResourceSlice({
      backend,
      stackKey: "tenant-a/deploy-214/api",
      program,
      fault: { failAfterStateWriteFor: "database", code: "provider-timeout" }
    });

    assert.equal(failed.status, "failed");
    assert.deepEqual(logicalNames(inspectStack(backend, "tenant-a/deploy-214/api").recorded), [
      "network",
      "database"
    ]);

    const destroyed = destroyPartialSlice({
      backend,
      stackKey: "tenant-a/deploy-214/api"
    });

    assert.equal(destroyed.status, "destroyed");
    assert.deepEqual(destroyed.destroyed.map((item) => item.logicalName), ["network", "database"]);
    assert.deepEqual(inspectStack(backend, "tenant-a/deploy-214/api").residue, []);
    assert.deepEqual(logicalNames(inspectStack(backend, "tenant-a/deploy-214/sibling").live), ["sibling-cache"]);
  });
}

test("retry after create-before-state crash adopts the orphan and does not duplicate infra", () => {
  const backend = createIacBackendHarness({
    backendName: "iac-pulumi",
    providerCreateSemantics: "non-idempotent"
  });

  const first = applyResourceSlice({
    backend,
    stackKey: "tenant-a/deploy-214/api",
    program,
    fault: { crashBeforeStateWriteFor: "database" }
  });

  assert.equal(first.status, "failed");
  assert.deepEqual(logicalNames(inspectStack(backend, "tenant-a/deploy-214/api").orphans), ["database"]);

  const retry = applyResourceSlice({
    backend,
    stackKey: "tenant-a/deploy-214/api",
    program
  });

  assert.equal(retry.status, "applied");
  assert.deepEqual(logicalNames(inspectStack(backend, "tenant-a/deploy-214/api").recorded), [
    "network",
    "database",
    "api"
  ]);
  assert.equal(backend.createAttemptsFor("tenant-a/deploy-214/api", "database"), 1);
  assert.equal(inspectStack(backend, "tenant-a/deploy-214/api").live.length, 3);
});

test("apply errors are classified and surfaced with resource precision", () => {
  const backend = createIacBackendHarness({ backendName: "iac-pulumi" });

  const retryable = applyResourceSlice({
    backend,
    stackKey: "tenant-a/deploy-214/api",
    program,
    fault: { crashBeforeStateWriteFor: "network" }
  });

  assert.deepEqual(retryable.error, {
    backendName: "iac-pulumi",
    classification: "retryable",
    code: "state-write-interrupted",
    logicalName: "network",
    stackKey: "tenant-a/deploy-214/api"
  });

  const fatal = applyResourceSlice({
    backend: createIacBackendHarness({ backendName: "iac-opentofu" }),
    stackKey: "tenant-a/deploy-214/api",
    program,
    fault: { rejectProviderConfigFor: "network", code: "unsupported-region" }
  });

  assert.deepEqual(fatal.error, {
    backendName: "iac-opentofu",
    classification: "fatal",
    code: "unsupported-region",
    logicalName: "network",
    stackKey: "tenant-a/deploy-214/api"
  });
});

test("fixture deployment past no-go threshold compensates all touched stacks to zero residue", () => {
  const backend = createIacBackendHarness({ backendName: "iac-pulumi" });
  applyResourceSlice({
    backend,
    stackKey: "tenant-a/deploy-214/network",
    program: [resource("vpc")]
  });
  applyResourceSlice({
    backend,
    stackKey: "tenant-a/deploy-214/api",
    program,
    fault: { failAfterStateWriteFor: "database" }
  });

  const result = compensateNoGoDeployment({
    backend,
    stackKeys: ["tenant-a/deploy-214/network", "tenant-a/deploy-214/api"]
  });

  assert.equal(result.status, "compensated");
  assert.deepEqual(result.residue, []);
  assert.deepEqual(inspectStack(backend, "tenant-a/deploy-214/network").residue, []);
  assert.deepEqual(inspectStack(backend, "tenant-a/deploy-214/api").residue, []);
});

test("created-but-not-recorded resources are tagged orphans and are swept by destroy", () => {
  const backend = createIacBackendHarness({ backendName: "iac-pulumi" });

  applyResourceSlice({
    backend,
    stackKey: "tenant-a/deploy-214/api",
    program,
    fault: { crashBeforeStateWriteFor: "network" }
  });

  assert.deepEqual(logicalNames(inspectStack(backend, "tenant-a/deploy-214/api").orphans), ["network"]);

  const destroy = destroyPartialSlice({
    backend,
    stackKey: "tenant-a/deploy-214/api"
  });

  assert.equal(destroy.status, "destroyed");
  assert.deepEqual(destroy.destroyed.map((item) => item.source), ["orphan-sweep"]);
  assert.deepEqual(inspectStack(backend, "tenant-a/deploy-214/api").residue, []);
});

test("destroy failure during compensation escalates with remaining residue", () => {
  const backend = createIacBackendHarness({ backendName: "iac-pulumi" });
  applyResourceSlice({
    backend,
    stackKey: "tenant-a/deploy-214/api",
    program,
    fault: { failAfterStateWriteFor: "database" }
  });

  const destroy = destroyPartialSlice({
    backend,
    stackKey: "tenant-a/deploy-214/api",
    fault: { failDestroyFor: "database", code: "provider-delete-denied" }
  });

  assert.equal(destroy.status, "compensation-failed");
  assert.deepEqual(destroy.error, {
    backendName: "iac-pulumi",
    classification: "fatal",
    code: "provider-delete-denied",
    logicalName: "database",
    stackKey: "tenant-a/deploy-214/api"
  });
  assert.deepEqual(logicalNames(destroy.remaining), ["database"]);
  assert.deepEqual(logicalNames(inspectStack(backend, "tenant-a/deploy-214/api").residue), ["database"]);
});

test("success reports that do not match reality are fatal rather than provisioned", () => {
  const backend = createIacBackendHarness({ backendName: "iac-pulumi" });

  const result = applyResourceSlice({
    backend,
    stackKey: "tenant-a/deploy-214/api",
    program,
    fault: { reportSuccessButRealityMissingFor: "database" }
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(result.error, {
    backendName: "iac-pulumi",
    classification: "fatal",
    code: "success-report-mismatch-reality",
    logicalName: "database",
    stackKey: "tenant-a/deploy-214/api"
  });
  assert.equal(result.events.some((event) => event.type === "resource.Provisioned"), false);
});

function resource(logicalName) {
  return { logicalName, kind: "test-resource" };
}

function logicalNames(items) {
  return items.map((item) => item.logicalName);
}
