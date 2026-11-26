import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  createSvidBoundHoboMcpServer,
  toolCapabilityFor,
} from "../src/mcp-svid-auth.js";

const NOW = new Date("2026-06-26T22:00:00.000Z");
const EXPIRY = new Date("2026-06-26T22:05:00.000Z");
const PRINCIPAL = { kind: "agent", id: "agent:builder" };

describe("HoBo MCP SVID auth and capability scoping", () => {
  it("requires a verified SVID and denies tools outside the session capability set", async () => {
    const audit = [];
    const server = createSvidBoundHoboMcpServer({
      svidAssertion: "valid-agent-svid",
      verifySvid: createVerifier({
        scopes: [toolCapabilityFor("plan")],
      }),
      now: () => NOW,
      auditSink: (event) => audit.push(event),
    });

    const planned = await server.callTool("plan", { cwd: "C:\\repo\\app" }, { toolCallId: "call-plan" });
    const deployed = await server.callTool("deploy", { cwd: "C:\\repo\\app" }, { toolCallId: "call-deploy" });

    assert.equal(planned.ok, true);
    assert.equal(deployed.ok, false);
    assert.equal(deployed.error.code, "MCP_SCOPE_DENIED");
    assert.deepEqual(audit.at(-1), {
      type: "policy.Decided",
      time: NOW.toISOString(),
      data: {
        decision: "deny",
        reason: "missing MCP tool capability",
        subject: PRINCIPAL,
        svidId: "spiffe://hobo.test/agent/builder",
        tool: "deploy",
        toolCallId: "call-deploy",
        requiredCapability: toolCapabilityFor("deploy"),
      },
    });

    const anonymousServer = createSvidBoundHoboMcpServer({
      verifySvid: createVerifier(),
      now: () => NOW,
    });
    const anonymousPlan = await anonymousServer.callTool("plan", { cwd: "C:\\repo\\app" });

    assert.equal(anonymousPlan.ok, false);
    assert.equal(anonymousPlan.error.code, "MCP_AUTH_REQUIRED");
  });

  it("routes request_token through the broker with a narrowed SVID scope and redacted audit trail", async () => {
    const audit = [];
    const requests = [];
    const server = createSvidBoundHoboMcpServer({
      svidAssertion: "valid-agent-svid",
      verifySvid: createVerifier({
        scopes: [
          toolCapabilityFor("request_token"),
          { port: "database", resource: "shop.db", actions: ["read", "write"] },
        ],
      }),
      tokenBroker: {
        async requestToken(request) {
          requests.push(request);
          return {
            ok: true,
            requestId: request.requestId,
            provider: request.provider,
            scope: request.scope,
            credential: {
              tokenRef: "vault://tokens/grant-1",
              accessToken: "plain-secret-token",
              expiresAt: "2026-06-26T22:02:00.000Z",
            },
            events: [
              {
                type: "token.Granted",
                data: {
                  grantId: "grant-1",
                  tokenRef: "vault://tokens/grant-1",
                  accessToken: "plain-secret-token",
                },
              },
              {
                type: "token.Used",
                data: {
                  grantId: "grant-1",
                  operation: "request_token",
                  tokenRef: "vault://tokens/grant-1",
                },
              },
            ],
          };
        },
      },
      now: () => NOW,
      auditSink: (event) => audit.push(event),
    });

    const result = await server.callTool(
      "request_token",
      {
        requestId: "req-1",
        provider: "acme-cloud",
        scope: { port: "database", resource: "shop.db", action: "read" },
        svidScope: [{ port: "database", resource: "shop.db", actions: ["write"] }],
      },
      { toolCallId: "call-token" },
    );

    assert.equal(result.ok, true);
    assert.deepEqual(requests[0], {
      requestId: "req-1",
      provider: "acme-cloud",
      scope: { port: "database", resource: "shop.db", action: "read" },
      svidScope: [{ port: "database", resource: "shop.db", actions: ["read"] }],
      subject: PRINCIPAL,
    });
    assert.equal(result.data.credential.tokenRef, "vault://tokens/grant-1");
    assert.equal(result.data.credential.accessToken, undefined);
    assert.ok(
      new Date(result.data.credential.expiresAt).getTime() <= NOW.getTime() + 5 * 60 * 1000,
      "request_token must return a short-lived credential",
    );
    assert.equal(JSON.stringify(result), JSON.stringify(result).replace("plain-secret-token", ""));

    const revoked = server.revokeToken("vault://tokens/grant-1", {
      reason: "session closed",
      toolCallId: "call-token",
    });

    assert.equal(revoked.ok, true);
    const tokenEvents = audit.filter((event) => event.type.startsWith("token."));
    assert.deepEqual(tokenEvents.map((event) => event.type), ["token.Granted", "token.Used", "token.Revoked"]);
    assert.equal(tokenEvents.every((event) => event.data.toolCallId === "call-token"), true);
    assert.equal(JSON.stringify(tokenEvents).includes("plain-secret-token"), false);
  });

  it("denies over-scope token requests before the broker and records an auditable decision", async () => {
    const audit = [];
    let brokerCalls = 0;
    const server = createSvidBoundHoboMcpServer({
      svidAssertion: "valid-agent-svid",
      verifySvid: createVerifier({
        scopes: [
          toolCapabilityFor("request_token"),
          { port: "database", resource: "shop.db", actions: ["read"] },
        ],
      }),
      tokenBroker: {
        async requestToken() {
          brokerCalls += 1;
          throw new Error("broker must not receive over-scope requests");
        },
      },
      now: () => NOW,
      auditSink: (event) => audit.push(event),
    });

    const result = await server.callTool(
      "request_token",
      {
        requestId: "req-2",
        provider: "acme-cloud",
        scope: { port: "database", resource: "shop.db", action: "write" },
        svidScope: [{ port: "database", resource: "shop.db", actions: ["write"] }],
      },
      { toolCallId: "call-over-scope" },
    );

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "MCP_SCOPE_DENIED");
    assert.equal(brokerCalls, 0);
    assert.equal(audit.at(-1).type, "policy.Decided");
    assert.equal(audit.at(-1).data.reason, "requested token scope exceeds SVID scope");
    assert.equal(audit.at(-1).data.toolCallId, "call-over-scope");
  });

  it("forces re-authentication when the SVID expires or is revoked mid-session", async () => {
    const revoked = new Set();
    const server = createSvidBoundHoboMcpServer({
      svidAssertion: "valid-agent-svid",
      verifySvid: createVerifier({
        revoked,
        scopes: [toolCapabilityFor("deploy")],
      }),
      now: () => NOW,
    });

    const firstDeploy = await server.callTool("deploy", { cwd: "C:\\repo\\app" });
    revoked.add("spiffe://hobo.test/agent/builder");
    const revokedDeploy = await server.callTool("deploy", { cwd: "C:\\repo\\app" });

    assert.equal(firstDeploy.ok, true);
    assert.equal(revokedDeploy.ok, false);
    assert.equal(revokedDeploy.error.code, "MCP_AUTH_REVOKED");

    const expiredServer = createSvidBoundHoboMcpServer({
      svidAssertion: "valid-agent-svid",
      verifySvid: createVerifier({ expiresAt: new Date("2026-06-26T21:59:59.000Z") }),
      now: () => NOW,
    });

    const expiredPlan = await expiredServer.callTool("plan", { cwd: "C:\\repo\\app" });

    assert.equal(expiredPlan.ok, false);
    assert.equal(expiredPlan.error.code, "MCP_AUTH_EXPIRED");
  });

  it("rejects forged and replayed SVID assertions through the verifier/JWKS seam", async () => {
    const forgedServer = createSvidBoundHoboMcpServer({
      svidAssertion: "forged-svid",
      verifySvid: createVerifier(),
      now: () => NOW,
    });
    const replayedServer = createSvidBoundHoboMcpServer({
      svidAssertion: "replayed-svid",
      verifySvid: createVerifier(),
      now: () => NOW,
    });

    const forged = await forgedServer.callTool("plan", { cwd: "C:\\repo\\app" });
    const replayed = await replayedServer.callTool("plan", { cwd: "C:\\repo\\app" });

    assert.equal(forged.ok, false);
    assert.equal(forged.error.code, "MCP_AUTH_INVALID");
    assert.match(forged.error.message, /issuer JWKS/);
    assert.equal(replayed.ok, false);
    assert.equal(replayed.error.code, "MCP_AUTH_REPLAYED");
  });
});

function createVerifier({
  expiresAt = EXPIRY,
  revoked = new Set(),
  scopes = [toolCapabilityFor("plan")],
} = {}) {
  return async (assertion) => {
    if (assertion === "replayed-svid") {
      return {
        ok: false,
        code: "SVID_REPLAYED",
        message: "SVID assertion replay rejected by verifier.",
      };
    }
    if (assertion !== "valid-agent-svid") {
      return {
        ok: false,
        code: "SVID_JWKS_REJECTED",
        message: "SVID assertion rejected against issuer JWKS.",
      };
    }
    if (revoked.has("spiffe://hobo.test/agent/builder")) {
      return {
        ok: false,
        code: "SVID_REVOKED",
        message: "SVID has been revoked.",
      };
    }

    return {
      ok: true,
      principal: PRINCIPAL,
      svid: {
        id: "spiffe://hobo.test/agent/builder",
        issuer: "spiffe://hobo.test/issuer",
        expiresAt: expiresAt.toISOString(),
      },
      scopes,
    };
  };
}
