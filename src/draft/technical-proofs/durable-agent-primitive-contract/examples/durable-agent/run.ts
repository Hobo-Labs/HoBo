import { buildSignedAuthManifestEnvelope } from "../../../hobo-auth-json-contract/src/auth-json.js";
import { agent, createAgentRuntime } from "../../src/durable-agent.js";

const fixedNow = () => new Date("2026-06-25T10:00:00.000Z");

const actor = {
  kind: "agent",
  id: "agent:ops",
  delegatedBy: { kind: "user", id: "user:priya" },
};

const svidScope = [{ port: "database", resource: "shop.db", actions: ["read", "write"] }];

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

const durableAgent = agent("ops", {
  model: "fixture-llm",
  instructions: "Write an order using brokered database credentials.",
  tools: {
    writeOrder: {
      async invoke(args) {
        return { ok: true, orderId: args.orderId, tokenRef: args.tokenRef };
      },
    },
  },
  async run(ctx, input) {
    const token = await ctx.token("acme-cloud", {
      port: "database",
      resource: "shop.db",
      action: "write",
    });
    return ctx.tool("writeOrder", {
      orderId: input.orderId,
      tokenRef: token.credential.tokenRef,
    });
  },
});

const runtime = createAgentRuntime({
  registry: {
    async resolveAuthManifest(provider) {
      if (provider !== "acme-cloud") {
        return null;
      }
      return signedAuthJson({
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
      });
    },
  },
  now: fixedNow,
  idFactory: (() => {
    let next = 1;
    return (prefix) => `${prefix}-${next++}`;
  })(),
});

const live = await runtime.run(durableAgent, { orderId: "ord-demo-1" }, { subject: actor, svidScope });
const replay = await runtime.replay(live);
const tokenEvents = runtime.getEventLog().filter((event) => event.type.startsWith("token."));

console.log(
  JSON.stringify(
    {
      example: "durable-agent",
      runId: live.runId,
      identity: live.identity.identityId,
      output: live.output,
      replayEqualsLive: replay.replayEqualsLive,
      tokenEventTypes: tokenEvents.map((event) => event.type),
      durableSteps: live.steps.map((step) => step.tool),
    },
    null,
    2,
  ),
);

if (!replay.replayEqualsLive) {
  throw new Error("examples/durable-agent: replayEqualsLive failed");
}

if (!tokenEvents.some((event) => event.type === "token.Granted")) {
  throw new Error("examples/durable-agent: expected token.Granted in event log");
}
