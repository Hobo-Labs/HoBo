import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { CATALOG } from "../../hobo-bindles-resource-catalog/src/catalog.js";
import {
  DevSecretResolutionError,
  LocalResolutionError,
  ReplayDivergenceError,
  defineDevSecret,
  defineResource,
  defineWorkflow,
  resolveDevSecretSource,
  resolveLocalCampResources,
  testRuntime,
} from "../src/local-dev-test-authoring.js";

const checkoutWorkflow = defineWorkflow("checkout", {
  initialState: (order) => ({
    orderId: order.id,
    status: "started",
    approved: false,
    charged: false,
    startedAt: null,
    paymentDueAt: null,
    settledAt: null,
    events: [],
  }),
  onStart(ctx, state) {
    ctx.emit("checkout.Started", { orderId: state.orderId });
    ctx.waitForHook("approval");
    return { ...state, startedAt: ctx.now() };
  },
  onHook(ctx, state, payload) {
    if (payload.ok !== true) {
      return { ...state, status: "rejected" };
    }
    ctx.emit("checkout.Approved", { orderId: state.orderId });
    const timer = ctx.sleep("10s", { id: "settle-payment", label: "payment-settle" });
    return { ...state, approved: true, paymentDueAt: timer.fireAt, status: "waiting-for-payment" };
  },
  onTimer(ctx, state, timer) {
    if (timer.label !== "payment-settle") {
      return state;
    }
    ctx.emit("checkout.Confirmed", { orderId: state.orderId });
    return { ...state, charged: true, settledAt: timer.fireAt, status: "confirmed" };
  },
});

describe("local dev/test authoring contract", () => {
  it("drives checkout through testRuntime start, resumeHook, clock.advance, and replay-equals-live", async () => {
    const runtime = testRuntime({ seed: "checkout-seed" });
    const run = await runtime.start(checkoutWorkflow, { id: "order-1" });

    await runtime.resumeHook(run, { ok: true });
    runtime.clock.advance("10s");

    assert.deepEqual(await runtime.replay(run), await runtime.state(run));
    assert.deepEqual(await runtime.state(run), {
      orderId: "order-1",
      status: "confirmed",
      approved: true,
      charged: true,
      startedAt: "2026-06-26T00:00:00.000Z",
      paymentDueAt: "2026-06-26T00:00:10.000Z",
      settledAt: "2026-06-26T00:00:10.000Z",
      events: [],
    });
    assert.deepEqual(await runtime.assertEmittedEvents(run), [
      { type: "checkout.Started", data: { orderId: "order-1" } },
      { type: "checkout.Approved", data: { orderId: "order-1" } },
      { type: "checkout.Confirmed", data: { orderId: "order-1" } },
    ]);
  });

  it("resolves every catalog resource to a local Camp equivalent without provider symbols", () => {
    const resources = CATALOG.map((entry) => defineResource(entry.factory, `${entry.factory}Local`));
    const plan = resolveLocalCampResources(resources);

    assert.equal(plan.camp, "local");
    assert.deepEqual(
      plan.resources.map(({ name, kind, requiresProviderSymbol }) => ({
        name,
        kind,
        requiresProviderSymbol,
      })),
      resources.map((resource) => ({
        name: resource.name,
        kind: resource.kind,
        requiresProviderSymbol: false,
      })),
    );
    assert.ok(plan.resources.every((resource) => resource.source === "local-equivalent"));
  });

  it("marks dev-only secret sources non-production and unsuitable for production can-deploy", () => {
    const secret = defineDevSecret("stripe/api-key");
    const resolved = resolveDevSecretSource(secret, {
      envLocal: { "stripe/api-key": "present" },
      ci: false,
    });

    assert.deepEqual(resolved, {
      ref: "stripe/api-key",
      camp: "local",
      source: "dev",
      sourceKind: ".env.local",
      production: false,
      canSatisfyProductionDeploy: false,
      valueAvailable: true,
      auditEvent: {
        type: "secret.Accessed",
        camp: "local",
        source: "dev",
        ref: "stripe/api-key",
      },
    });
  });

  it("fails replay-equals-live loudly for ambient nondeterminism", async () => {
    let ambientCounter = 0;
    const nondeterministic = defineWorkflow("bad-clock", {
      initialState: () => ({ sample: null }),
      onStart() {
        ambientCounter += 1;
        return { sample: ambientCounter };
      },
    });
    const runtime = testRuntime();
    const run = await runtime.start(nondeterministic, {});

    await assert.rejects(
      () => runtime.replay(run),
      (error) => {
        assert.ok(error instanceof ReplayDivergenceError);
        assert.match(error.message, /replay diverged from live state/);
        return true;
      },
    );
  });

  it("skips interactive secret prompts in CI without invoking the prompt function", () => {
    let promptCalled = false;

    assert.throws(
      () =>
        resolveDevSecretSource(defineDevSecret("stripe/api-key"), {
          ci: true,
          prompt() {
            promptCalled = true;
            return "should-not-run";
          },
        }),
      (error) => {
        assert.ok(error instanceof DevSecretResolutionError);
        assert.equal(error.skippedInteractivePrompt, true);
        return true;
      },
    );
    assert.equal(promptCalled, false);
  });

  it("fails fast when a resource has no local equivalent", () => {
    assert.throws(
      () =>
        resolveLocalCampResources([defineResource("bucket", "uploads")], {
          equivalents: { kv: { driver: "memory-kv" } },
        }),
      (error) => {
        assert.ok(error instanceof LocalResolutionError);
        assert.match(error.message, /no local equivalent for bucket uploads/);
        return true;
      },
    );
  });
});
