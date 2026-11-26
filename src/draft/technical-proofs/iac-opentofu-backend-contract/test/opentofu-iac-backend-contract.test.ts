import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  createFixtureIacProgram as createPulumiFixtureIacProgram,
} from "../../iac-pulumi-backend-contract/src/pulumi-iac-backend-contract.js";

import {
  PINNED_OPENTOFU_VERSION,
  createInMemoryOpenTofuBinary,
  createOpenTofuAdapter,
  createOpenTofuFixtureIacProgram,
  runIacBackendConformance,
} from "../src/opentofu-iac-backend-contract.js";

describe("@hobo/iac-opentofu backend contract", () => {
  it("previews, applies, refreshes, and destroys the same fixture shape used by iac-pulumi", async () => {
    const pulumiFixture = createPulumiFixtureIacProgram();
    const openTofuFixture = createOpenTofuFixtureIacProgram();
    const binary = createInMemoryOpenTofuBinary();
    const iac = createOpenTofuAdapter({ binary });

    assert.deepEqual(
      openTofuFixture.resources.map(({ name, type, inputs, outputs }) => ({ name, type, inputs, outputs })),
      pulumiFixture.resources.map(({ name, type, inputs, outputs }) => ({ name, type, inputs, outputs })),
    );

    const preview = await iac.preview(openTofuFixture);

    assert.deepEqual(preview, {
      kind: "diff",
      provider: "opentofu",
      changes: [
        { op: "create", resource: "cache", reason: "missing-from-state" },
        { op: "create", resource: "assets", reason: "missing-from-state" },
      ],
      dirty: true,
    });

    const outputs = await iac.apply(openTofuFixture);

    assert.deepEqual(outputs, {
      kind: "outputs",
      provider: "opentofu",
      resources: {
        cache: {
          id: "opentofu:local:cache",
          status: "provisioned",
          outputs: {
            endpoint: "memory://cache",
            resourceId: "opentofu:local:cache",
          },
        },
        assets: {
          id: "opentofu:local:assets",
          status: "provisioned",
          outputs: {
            endpoint: "memory://assets",
            resourceId: "opentofu:local:assets",
          },
        },
      },
      stackOutputs: {
        assetEndpoint: "memory://assets",
        cacheEndpoint: "memory://cache",
      },
    });

    assert.deepEqual(await iac.preview(openTofuFixture), {
      kind: "diff",
      provider: "opentofu",
      changes: [],
      dirty: false,
    });
    assert.deepEqual(await iac.refresh(openTofuFixture), {
      kind: "drift-report",
      provider: "opentofu",
      drifted: false,
      resources: [],
    });
    assert.deepEqual(await iac.destroy(openTofuFixture), {
      kind: "outputs",
      provider: "opentofu",
      resources: {
        cache: { id: "opentofu:local:cache", status: "destroyed", outputs: {} },
        assets: { id: "opentofu:local:assets", status: "destroyed", outputs: {} },
      },
      stackOutputs: {},
    });
    assert.deepEqual(
      binary.commandLog().map((entry) => entry.command),
      ["plan", "plan", "apply", "plan", "refresh", "destroy"],
    );
  });

  it("fails precisely when the OpenTofu binary version is not pinned", () => {
    assert.throws(
      () =>
        createOpenTofuAdapter({
          binary: createInMemoryOpenTofuBinary(),
          tofuVersion: "9.9.9",
        }),
      new RegExp(`OpenTofu version mismatch: expected ${PINNED_OPENTOFU_VERSION}, got 9.9.9`),
    );
  });

  it("reports drift when OpenTofu state changes out of band", async () => {
    const binary = createInMemoryOpenTofuBinary();
    const iac = createOpenTofuAdapter({ binary });
    const program = createOpenTofuFixtureIacProgram();

    await iac.apply(program);
    binary.mutateState("cache", { inputs: { durability: "persistent" } });

    assert.deepEqual(await iac.refresh(program), {
      kind: "drift-report",
      provider: "opentofu",
      drifted: true,
      resources: [{ name: "cache", reason: "spec-drift" }],
    });
  });

  it("applies delete changes so removed resources do not remain as drift", async () => {
    const binary = createInMemoryOpenTofuBinary();
    const iac = createOpenTofuAdapter({ binary });
    const expandedProgram = createOpenTofuFixtureIacProgram({
      resources: [
        ...createOpenTofuFixtureIacProgram().resources,
        {
          name: "scratch",
          type: "wasi:keyvalue/store",
          provider: "local",
          inputs: { durability: "ephemeral" },
          outputs: ["endpoint", "resourceId"],
        },
      ],
    });
    const baseProgram = createOpenTofuFixtureIacProgram();

    await iac.apply(expandedProgram);
    assert.deepEqual(await iac.preview(baseProgram), {
      kind: "diff",
      provider: "opentofu",
      changes: [{ op: "delete", resource: "scratch", reason: "extra-in-state" }],
      dirty: true,
    });

    await iac.apply(baseProgram);

    assert.deepEqual(await iac.refresh(baseProgram), {
      kind: "drift-report",
      provider: "opentofu",
      drifted: false,
      resources: [],
    });
  });

  it("passes the shared IaC-backend conformance suite for the fixture program", async () => {
    const report = await runIacBackendConformance({
      adapter: createOpenTofuAdapter({ binary: createInMemoryOpenTofuBinary() }),
      program: createOpenTofuFixtureIacProgram(),
    });

    assert.deepEqual(report, {
      suite: "@hobo/conformance/iac-backend",
      provider: "opentofu",
      passed: true,
      assertions: ["preview-diff", "apply-outputs", "refresh-clean", "destroy-clean"],
    });
  });

  it("surfaces IacProgram features with no clean HCL mapping before planning", async () => {
    const iac = createOpenTofuAdapter({ binary: createInMemoryOpenTofuBinary() });
    const program = createOpenTofuFixtureIacProgram({
      resources: [
        {
          name: "graph",
          type: "hobo:graph/cluster",
          provider: "local",
          inputs: {},
          outputs: ["endpoint"],
        },
      ],
      stackOutputs: {
        graphEndpoint: "${resources.graph.outputs.endpoint}",
      },
    });

    await assert.rejects(() => iac.preview(program), {
      name: "OpenTofuProgramError",
      code: "unsupported-hcl-mapping",
      message: /no OpenTofu HCL mapping for resource graph type hobo:graph\/cluster/,
    });
  });

  it("fails closed when the OpenTofu state backend lock is held", async () => {
    const binary = createInMemoryOpenTofuBinary();
    const iac = createOpenTofuAdapter({ binary });
    const program = createOpenTofuFixtureIacProgram();

    binary.holdStateLock(program.stack, "resource-actor:other");

    await assert.rejects(() => iac.apply(program), {
      name: "OpenTofuApplyError",
      code: "state-lock-held",
      message: /OpenTofu state lock for hobo-opentofu-fixture is held by resource-actor:other/,
    });
  });

  it("rejects binary plan skew instead of trusting a different OpenTofu plan", async () => {
    const iac = createOpenTofuAdapter({
      binary: createInMemoryOpenTofuBinary({ skewPlan: true }),
    });

    await assert.rejects(() => iac.preview(createOpenTofuFixtureIacProgram()), {
      name: "OpenTofuPlanError",
      code: "binary-plan-skew",
      message: /OpenTofu binary plan diverged from compiled HCL for sidecar/,
    });
  });

  it("rejects binary plan skew when OpenTofu omits a compiled resource", async () => {
    const iac = createOpenTofuAdapter({
      binary: createInMemoryOpenTofuBinary({ dropPlanResource: "assets" }),
    });

    await assert.rejects(() => iac.preview(createOpenTofuFixtureIacProgram()), {
      name: "OpenTofuPlanError",
      code: "binary-plan-skew",
      message: /OpenTofu binary plan diverged from compiled HCL for assets/,
    });
  });

  it("rejects binary plan skew when OpenTofu changes the planned operation", async () => {
    const iac = createOpenTofuAdapter({
      binary: createInMemoryOpenTofuBinary({ rewritePlanOp: { resource: "cache", op: "delete" } }),
    });

    await assert.rejects(() => iac.preview(createOpenTofuFixtureIacProgram()), {
      name: "OpenTofuPlanError",
      code: "binary-plan-skew",
      message: /OpenTofu binary plan diverged from compiled HCL for cache/,
    });
  });

  it("surfaces partial apply state without implementing compensation in this adapter slice", async () => {
    const binary = createInMemoryOpenTofuBinary({ failAfterResource: "cache" });
    const iac = createOpenTofuAdapter({ binary });
    const program = createOpenTofuFixtureIacProgram();

    await assert.rejects(() => iac.apply(program), {
      name: "OpenTofuApplyError",
      code: "partial-apply",
      message: /partial apply failed after cache before assets/,
    });
    assert.deepEqual(await iac.refresh(program), {
      kind: "drift-report",
      provider: "opentofu",
      drifted: true,
      resources: [
        { name: "cache", reason: "partial-apply-provisioned" },
        { name: "assets", reason: "not-applied-after-partial-failure" },
      ],
    });
  });
});
