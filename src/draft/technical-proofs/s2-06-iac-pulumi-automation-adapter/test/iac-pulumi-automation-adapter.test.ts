import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import {
  ADAPTER_ID,
  PINNED_PULUMI_AUTOMATION_VERSION,
  createInMemoryAutomationEngine,
  createInMemoryStateBackend,
  createPerResourceStackKey,
  createPulumiAutomationAdapter,
  createStateBackendConfig,
  createTrivialIacProgram,
  runIacBackendConformance,
  validateIacProgram,
} from "../src/iac-pulumi-automation-adapter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const providersFixturePath = path.resolve(
  __dirname,
  "fixtures",
  "providers-shop-api-iac-program.json",
);

async function loadProvidersFixtureProgram() {
  return validateIacProgram(JSON.parse(await readFile(providersFixturePath, "utf8")));
}

describe("S2-06 @hobo/iac-pulumi Automation API adapter (HOBO-621)", () => {
  it("Given a trivial IacProgram, When preview/apply/refresh/destroy round-trip, Then typed outputs and bindings return", async () => {
    const adapter = createPulumiAutomationAdapter();
    const program = createTrivialIacProgram();

    const preview = await adapter.preview(program);

    assert.equal(preview.model, "per-resource-stack");
    assert.equal(preview.dirty, true);
    assert.deepEqual(preview.changes, [
      {
        op: "create",
        resource: "hello",
        stackKey: "trivial-demo/hello",
        reason: "missing-from-per-resource-stack",
      },
    ]);

    const outputs = await adapter.apply(program);

    assert.equal(outputs.kind, "outputs");
    assert.equal(outputs.resources.hello.stackKey, "trivial-demo/hello");
    assert.equal(outputs.resources.hello.outputs.greeting, "hello-bindle");
    assert.equal(outputs.stackOutputs.greeting, "hello-bindle");
    assert.equal(outputs.bindings["hello.greeting"], "hello-bindle");
    assert.equal(outputs.bindings["${resources.hello.outputs.greeting}"], "hello-bindle");

    assert.deepEqual(await adapter.refresh(program), {
      kind: "drift-report",
      provider: "pulumi",
      model: "per-resource-stack",
      drifted: false,
      resources: [],
    });

    const destroy = await adapter.destroy(program);

    assert.equal(destroy.resources.hello.status, "destroyed");
    assert.deepEqual(destroy.stackOutputs, {});
  });

  it("Given providers epic recorded fixture, When adapter runs, Then per-resource stacks isolate blast radius", async () => {
    const stateBackend = createInMemoryStateBackend();
    const adapter = createPulumiAutomationAdapter({
      engine: createInMemoryAutomationEngine({ stateBackend }),
    });
    const program = await loadProvidersFixtureProgram();

    await adapter.apply(program);

    assert.deepEqual(Object.keys(stateBackend.snapshot()).sort(), [
      "shop-demo/assets",
      "shop-demo/cache",
    ]);
    assert.equal(
      createPerResourceStackKey(program, "cache"),
      "shop-demo/cache",
    );
    assert.equal(
      createPerResourceStackKey(program, "assets"),
      "shop-demo/assets",
    );
  });

  it("Given state backend config, When lock held by another actor, Then apply fails closed", async () => {
    const stateBackend = createInMemoryStateBackend();
    const program = createTrivialIacProgram();
    const stackKey = createPerResourceStackKey(program, "hello");

    stateBackend.holdLock(stackKey, "resource-actor:other");

    const adapter = createPulumiAutomationAdapter({
      engine: createInMemoryAutomationEngine({ stateBackend }),
    });

    await assert.rejects(() => adapter.apply(program), {
      name: "PulumiStateError",
      code: "state-lock-held",
      message: /held by resource-actor:other/,
    });
  });

  it("passes @hobo/conformance/iac-backend for trivial and providers fixtures", async () => {
    const adapter = createPulumiAutomationAdapter();

    assert.deepEqual(await runIacBackendConformance({ adapter, program: createTrivialIacProgram() }), {
      suite: "@hobo/conformance/iac-backend",
      provider: "pulumi",
      passed: true,
      assertions: ["preview-diff", "apply-outputs", "binding-outputs", "refresh-clean", "destroy-clean"],
    });

    assert.deepEqual(await runIacBackendConformance({
      adapter: createPulumiAutomationAdapter(),
      program: await loadProvidersFixtureProgram(),
    }), {
      suite: "@hobo/conformance/iac-backend",
      provider: "pulumi",
      passed: true,
      assertions: ["preview-diff", "apply-outputs", "binding-outputs", "refresh-clean", "destroy-clean"],
    });
  });

  it("fails precisely when Automation API version drifts", () => {
    assert.throws(
      () =>
        createPulumiAutomationAdapter({
          engine: createInMemoryAutomationEngine(),
          pulumiVersion: "9.9.9",
        }),
      new RegExp(
        `Pulumi Automation API version mismatch: expected ${PINNED_PULUMI_AUTOMATION_VERSION}, got 9.9.9`,
      ),
    );
  });

  it("turns preview/apply non-determinism into explicit failed apply and drift report", async () => {
    const adapter = createPulumiAutomationAdapter({
      engine: createInMemoryAutomationEngine({ divergeOnApply: true }),
    });
    const program = createTrivialIacProgram();

    await assert.rejects(() => adapter.apply(program), {
      name: "PulumiApplyError",
      code: "preview-apply-divergence",
      message: /unexpected resource sidecar/,
    });

    const refresh = await adapter.refresh(program);

    assert.equal(refresh.drifted, true);
    assert.equal(refresh.resources[0].name, "sidecar");
  });

  it("surfaces partial apply per-resource stack state without pretending convergence", async () => {
    const adapter = createPulumiAutomationAdapter({
      engine: createInMemoryAutomationEngine({ failAfterResource: "hello" }),
    });
    const program = createTrivialIacProgram();

    await assert.rejects(() => adapter.apply(program), {
      name: "PulumiApplyError",
      code: "partial-apply",
      message: /partial apply failed after hello/,
    });

    const refresh = await adapter.refresh(program);

    assert.equal(refresh.drifted, true);
    assert.equal(refresh.resources[0].reason, "partial-apply-provisioned");
  });

  it("rejects unresolved stack output references before apply", async () => {
    const adapter = createPulumiAutomationAdapter();
    const program = createTrivialIacProgram({
      stackOutputs: {
        missing: "${resources.missing.outputs.greeting}",
      },
    });

    await assert.rejects(() => adapter.apply(program), {
      name: "PulumiProgramError",
      code: "unresolved-output-reference",
      message: /resources\.missing\.outputs\.greeting/,
    });
  });

  it("exposes adapter identity and pluggable state backend config", () => {
    const config = createStateBackendConfig({ kind: "memory", lockHolder: "yard-object-store" });
    const adapter = createPulumiAutomationAdapter({
      stateBackend: createInMemoryStateBackend(),
    });

    assert.equal(adapter.id, ADAPTER_ID);
    assert.equal(adapter.pulumiVersion, PINNED_PULUMI_AUTOMATION_VERSION);
    assert.deepEqual(config, { kind: "memory", lockHolder: "yard-object-store" });
    assert.deepEqual(adapter.stateBackend, { kind: "memory", lockHolder: null });
  });
});
