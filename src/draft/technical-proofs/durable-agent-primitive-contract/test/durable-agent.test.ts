import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { buildSignedAuthManifestEnvelope } from "../../hobo-auth-json-contract/src/auth-json.js";
import {
  agent,
  AgentReplayDivergenceError,
  createAgentRuntime,
} from "../src/durable-agent.js";

const fixedNow = () => new Date("2026-06-25T10:00:00.000Z");

const actor = {
  kind: "agent",
  id: "agent:ops",
  delegatedBy: { kind: "user", id: "user:priya" },
};

const svidScope = [{ port: "database", resource: "shop.db", actions: ["read", "write"] }];

function fixtureRegistry(manifests) {
  return {
    async resolveAuthManifest(provider) {
      return manifests[provider] ?? null;
    },
  };
}

function signedAuthJson(overrides = {}) {
  return buildSignedAuthManifestEnvelope(
    {
      issuer: overrides.issuer ?? "https://identity.fixture.test",
      flows: overrides.flows,
      scopeModel: "least-privilege-per-resource",
      resourceIndicators: overrides.resourceIndicators ?? ["urn:fixture:resource"],
      tokenLifetimeSec: 300,
      audit: { events: ["token.Granted", "token.Used", "token.Denied"] },
    },
    { issuer: overrides.issuer ?? "https://identity.fixture.test", keyId: "fixture-key" },
  );
}

function deterministicIds() {
  let next = 1;
  return (prefix) => `${prefix}-${next++}`;
}

describe("durable agent() primitive", () => {
  it("runs tools as durable steps with ctx.identity injected", async () => {
    const toolCalls = [];
    const opsAgent = agent("ops", {
      model: "fixture-llm",
      instructions: "Provision database access and write a row.",
      tools: {
        writeOrder: {
          description: "Write an order row using a brokered token.",
          async invoke(args, ctx) {
            toolCalls.push({ args, identityId: ctx.identity.identityId });
            return { ok: true, orderId: args.orderId };
          },
        },
      },
      async run(ctx, input) {
        assert.equal(ctx.identity.svidRef, "identity://svid/svid-1");
        const token = await ctx.token("acme-cloud", {
          port: "database",
          resource: "shop.db",
          action: "write",
        });
        assert.equal(token.ok, true);
        return ctx.tool("writeOrder", { orderId: input.orderId, tokenRef: token.credential.tokenRef });
      },
    });

    const runtime = createAgentRuntime({
      registry: fixtureRegistry({
        "acme-cloud": signedAuthJson({
          issuer: "https://identity.acme.test",
          flows: [
            {
              type: "oidc-federation",
              audience: "urn:acme:database",
              exchange: "https://sts.acme.test/token",
              trust: { oidcDiscovery: "https://identity.acme.test/.well-known/openid-configuration" },
            },
          ],
          resourceIndicators: ["urn:acme:database"],
        }),
      }),
      now: fixedNow,
      idFactory: deterministicIds(),
    });

    const result = await runtime.run(opsAgent, { orderId: "ord-42" }, { subject: actor, svidScope });

    assert.equal(result.output.ok, true);
    assert.equal(result.output.orderId, "ord-42");
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].tool, "writeOrder");
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].identityId, "svid-1");

    const eventTypes = runtime.getEventLog().map((event) => event.type);
    assert.equal(eventTypes.includes("identity.Issued"), true);
    assert.equal(eventTypes.includes("token.Granted"), true);
    assert.equal(eventTypes.includes("token.Used"), true);
  });

  it("replays agent runs with replayEqualsLive", async () => {
    let liveToolExecutions = 0;
    const counterAgent = agent("counter", {
      tools: {
        increment: {
          async invoke() {
            liveToolExecutions += 1;
            return { value: liveToolExecutions };
          },
        },
      },
      async run(ctx) {
        const first = await ctx.tool("increment");
        const second = await ctx.tool("increment");
        return { total: first.value + second.value };
      },
    });

    const runtime = createAgentRuntime({
      registry: fixtureRegistry({}),
      now: fixedNow,
      idFactory: deterministicIds(),
    });

    const live = await runtime.run(counterAgent, {}, { subject: actor, svidScope });
    assert.equal(live.output.total, 3);
    assert.equal(liveToolExecutions, 2);

    liveToolExecutions = 0;
    const replay = await runtime.replay(live);
    assert.equal(replay.replayEqualsLive, true);
    assert.equal(liveToolExecutions, 0);
  });

  it("fails replay when agent run uses ambient nondeterminism outside tool steps", async () => {
    let callCount = 0;
    const ambientAgent = agent("ambient", {
      tools: {},
      async run() {
        callCount += 1;
        return { value: callCount };
      },
    });

    const runtime = createAgentRuntime({
      registry: fixtureRegistry({}),
      now: fixedNow,
      idFactory: deterministicIds(),
    });

    const live = await runtime.run(ambientAgent, {}, { subject: actor, svidScope });

    await assert.rejects(
      () => runtime.replay(live),
      (error) => error instanceof AgentReplayDivergenceError,
    );
  });

  it("denies ctx.token outside SVID scope without tool execution", async () => {
    let toolRan = false;
    const scopedAgent = agent("scoped", {
      tools: {
        admin: {
          async invoke() {
            toolRan = true;
            return { ok: true };
          },
        },
      },
      async run(ctx) {
        const denied = await ctx.token("acme-cloud", {
          port: "database",
          resource: "shop.db",
          action: "admin",
        });
        if (!denied.ok) {
          return { denied: true, reason: denied.reason };
        }
        return ctx.tool("admin");
      },
    });

    const runtime = createAgentRuntime({
      registry: fixtureRegistry({
        "acme-cloud": signedAuthJson({
          issuer: "https://identity.acme.test",
          flows: [
            {
              type: "oidc-federation",
              audience: "urn:acme:database",
              exchange: "https://sts.acme.test/token",
              trust: { oidcDiscovery: "https://identity.acme.test/.well-known/openid-configuration" },
            },
          ],
          resourceIndicators: ["urn:acme:database"],
        }),
      }),
      now: fixedNow,
      idFactory: deterministicIds(),
    });

    const result = await runtime.run(scopedAgent, {}, { subject: actor, svidScope });
    assert.equal(result.output.denied, true);
    assert.match(result.output.reason, /outside caller SVID scope/);
    assert.equal(toolRan, false);

    const tokenEvents = runtime.getEventLog().filter((event) => event.type.startsWith("token."));
    assert.deepEqual(tokenEvents.map((event) => event.type), ["token.Denied"]);
  });
});
