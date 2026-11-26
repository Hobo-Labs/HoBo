import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  createFakeCapability,
  createFakeCloudProvider,
  createFakeIacProvider,
  createPortRequest,
  matchCapability,
  planResource,
} from "../src/provider-ports.js";

describe("provider port contract", () => {
  it("matches full, partial, and none capability outcomes over fixture port requests", () => {
    const capability = createFakeCapability({
      port: "wasi:keyvalue/store",
      supports: ["read", "write"],
      cost: { unit: "operation", marginal: 0.000001, currency: "USD" },
    });

    const full = capability.satisfies(
      createPortRequest("cache", "wasi:keyvalue/store", {
        verbs: ["read"],
        strictness: "require",
      }),
    );
    const partial = capability.satisfies(
      createPortRequest("cache", "wasi:keyvalue/store", {
        verbs: ["read", "watch"],
        strictness: "prefer",
      }),
    );
    const none = capability.satisfies(
      createPortRequest("files", "wasi:blobstore/container", {
        verbs: ["read"],
      }),
    );

    assert.deepEqual(full, { level: "full", missing: [] });
    assert.deepEqual(partial, { level: "partial", missing: ["watch"] });
    assert.deepEqual(none, { level: "none", missing: ["port"] });
    assert.deepEqual(capability.estimateCost(full), {
      unit: "operation",
      marginal: 0.000001,
      currency: "USD",
    });
  });

  it("distinguishes partial require rejection from prefer degradation", () => {
    const capability = createFakeCapability({
      port: "wasi:keyvalue/store",
      supports: ["read"],
    });

    const required = matchCapability(
      capability,
      createPortRequest("cache", "wasi:keyvalue/store", {
        verbs: ["read", "write"],
        strictness: "require",
      }),
    );
    const preferred = matchCapability(
      capability,
      createPortRequest("cache", "wasi:keyvalue/store", {
        verbs: ["read", "write"],
        strictness: "prefer",
      }),
    );

    assert.equal(required.accepted, false);
    assert.equal(required.reason, "missing-required-capability");
    assert.deepEqual(required.missing, ["write"]);

    assert.equal(preferred.accepted, true);
    assert.equal(preferred.reason, "preferred-capability-degraded");
    assert.deepEqual(preferred.warnings, ["missing preferred capability: write"]);
  });

  it("realizes a ResourcePlan into typed IaC, optional BuildSpec, manifest, and client seams", async () => {
    const cloud = createFakeCloudProvider({
      id: "local",
      regions: ["local"],
      capabilities: [
        createFakeCapability({
          port: "wasi:keyvalue/store",
          supports: ["read", "write"],
        }),
      ],
    });

    const result = await cloud.realize(
      planResource({
        name: "cache",
        port: "wasi:keyvalue/store",
        provider: "local",
        options: { durability: "ephemeral" },
      }),
    );

    assert.equal(result.iac.kind, "iac-program");
    assert.equal(result.iac.provider, "local");
    assert.deepEqual(result.iac.resources, [
      {
        name: "cache",
        port: "wasi:keyvalue/store",
        options: { durability: "ephemeral" },
      },
    ]);
    assert.equal(result.build, undefined);
    assert.deepEqual(cloud.capabilityManifest().capabilities, [
      { port: "wasi:keyvalue/store", verbs: ["read", "write"] },
    ]);
    assert.deepEqual(cloud.client("wasi:keyvalue/store", { endpoint: "memory://cache" }), {
      port: "wasi:keyvalue/store",
      outputs: { endpoint: "memory://cache" },
    });
  });

  it("returns well-typed preview, apply, refresh, and destroy results from an IacProvider", async () => {
    const iac = createFakeIacProvider("pulumi-local");
    const program = {
      kind: "iac-program",
      provider: "local",
      resources: [{ name: "cache", port: "wasi:keyvalue/store", options: {} }],
    };

    assert.deepEqual(await iac.preview(program), {
      kind: "diff",
      provider: "pulumi-local",
      changes: [{ op: "create", resource: "cache" }],
      dirty: false,
    });
    assert.deepEqual(await iac.apply(program), {
      kind: "outputs",
      provider: "pulumi-local",
      resources: { cache: { id: "pulumi-local:cache", status: "provisioned" } },
    });
    assert.deepEqual(await iac.refresh(program), {
      kind: "drift-report",
      provider: "pulumi-local",
      drifted: false,
      resources: [],
    });
    assert.deepEqual(await iac.destroy(program), {
      kind: "outputs",
      provider: "pulumi-local",
      resources: { cache: { id: "pulumi-local:cache", status: "destroyed" } },
    });
  });

  it("surfaces preview-clean/apply-dirty as a drift seam, not as success", async () => {
    const iac = createFakeIacProvider("pulumi-local", {
      dirtyOnApply: true,
    });
    const program = {
      kind: "iac-program",
      provider: "local",
      resources: [{ name: "db", port: "wasi:sql/database", options: {} }],
    };

    assert.equal((await iac.preview(program)).dirty, false);
    await assert.rejects(() => iac.apply(program), /apply became dirty/i);
    assert.deepEqual(await iac.refresh(program), {
      kind: "drift-report",
      provider: "pulumi-local",
      drifted: true,
      resources: [{ name: "db", reason: "apply-dirty-after-clean-preview" }],
    });
  });

  it("degrades absent cost signals to no objective input", () => {
    const capability = createFakeCapability({
      port: "wasi:blobstore/container",
      supports: ["read", "write"],
    });

    const request = createPortRequest("assets", "wasi:blobstore/container", {
      verbs: ["read"],
    });
    const match = matchCapability(capability, request);

    assert.equal(match.accepted, true);
    assert.deepEqual(match.cost, {
      kind: "cost-signal",
      objectiveInput: "none",
      reason: "absent-cost-signal",
    });
  });
});
