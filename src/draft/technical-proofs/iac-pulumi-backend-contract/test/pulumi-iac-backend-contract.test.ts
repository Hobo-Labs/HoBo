import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  PINNED_PULUMI_AUTOMATION_VERSION,
  createFixtureIacProgram,
  createInMemoryAutomationEngine,
  createPulumiAutomationAdapter,
} from "../src/pulumi-iac-backend-contract.js";

describe("@hobo/iac-pulumi Automation API backend contract", () => {
  it("previews, applies, refreshes, and destroys a fixture IacProgram without shelling out", async () => {
    const engine = createInMemoryAutomationEngine();
    const iac = createPulumiAutomationAdapter({ engine });
    const program = createFixtureIacProgram();

    const preview = await iac.preview(program);

    assert.equal(preview.kind, "diff");
    assert.equal(preview.provider, "pulumi");
    assert.equal(preview.dirty, true);
    assert.deepEqual(preview.changes, [
      { op: "create", resource: "cache", reason: "missing-from-stack" },
      { op: "create", resource: "assets", reason: "missing-from-stack" },
    ]);

    const outputs = await iac.apply(program);

    assert.deepEqual(outputs, {
      kind: "outputs",
      provider: "pulumi",
      resources: {
        cache: {
          id: "pulumi:local:cache",
          status: "provisioned",
          outputs: {
            endpoint: "memory://cache",
            resourceId: "pulumi:local:cache",
          },
        },
        assets: {
          id: "pulumi:local:assets",
          status: "provisioned",
          outputs: {
            endpoint: "memory://assets",
            resourceId: "pulumi:local:assets",
          },
        },
      },
      stackOutputs: {
        assetEndpoint: "memory://assets",
        cacheEndpoint: "memory://cache",
      },
    });

    assert.deepEqual(await iac.refresh(program), {
      kind: "drift-report",
      provider: "pulumi",
      drifted: false,
      resources: [],
    });
    assert.deepEqual(await iac.preview(program), {
      kind: "diff",
      provider: "pulumi",
      changes: [],
      dirty: false,
    });
    assert.deepEqual(await iac.destroy(program), {
      kind: "outputs",
      provider: "pulumi",
      resources: {
        cache: { id: "pulumi:local:cache", status: "destroyed", outputs: {} },
        assets: { id: "pulumi:local:assets", status: "destroyed", outputs: {} },
      },
      stackOutputs: {},
    });
    assert.deepEqual(engine.commandLog(), []);
  });

  it("fails precisely when the embedded Pulumi Automation API version is not the pinned version", () => {
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

  it("turns preview/apply non-determinism into an explicit failed apply and drift report", async () => {
    const engine = createInMemoryAutomationEngine({ divergeOnApply: true });
    const iac = createPulumiAutomationAdapter({ engine });
    const program = createFixtureIacProgram();

    await assert.rejects(() => iac.apply(program), {
      name: "PulumiApplyError",
      code: "preview-apply-divergence",
      message: /preview\/apply divergence: apply attempted unexpected resource sidecar/,
    });
    assert.deepEqual(await iac.refresh(program), {
      kind: "drift-report",
      provider: "pulumi",
      drifted: true,
      resources: [{ name: "sidecar", reason: "preview-apply-divergence" }],
    });
    assert.deepEqual(engine.commandLog(), []);
  });

  it("surfaces partial apply state without pretending the stack converged", async () => {
    const engine = createInMemoryAutomationEngine({ failAfterResource: "cache" });
    const iac = createPulumiAutomationAdapter({ engine });
    const program = createFixtureIacProgram();

    await assert.rejects(() => iac.apply(program), {
      name: "PulumiApplyError",
      code: "partial-apply",
      message: /partial apply failed after cache before assets/,
    });
    assert.deepEqual(await iac.refresh(program), {
      kind: "drift-report",
      provider: "pulumi",
      drifted: true,
      resources: [
        { name: "cache", reason: "partial-apply-provisioned" },
        { name: "assets", reason: "not-applied-after-partial-failure" },
      ],
    });
  });

  it("rejects stack outputs that reference never-provisioned resources before apply", async () => {
    const engine = createInMemoryAutomationEngine();
    const iac = createPulumiAutomationAdapter({ engine });
    const program = createFixtureIacProgram({
      stackOutputs: {
        missingEndpoint: "${resources.missing.outputs.endpoint}",
      },
    });

    await assert.rejects(() => iac.apply(program), {
      name: "PulumiProgramError",
      code: "unresolved-output-reference",
      message: /unresolved output reference resources\.missing\.outputs\.endpoint/,
    });
    assert.deepEqual(engine.snapshot().resources, {});
    assert.deepEqual(engine.commandLog(), []);
  });
});
