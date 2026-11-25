import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

import { CANONICAL_VERBS, createHoboCli } from "../../hobo-cli-shell-contract/src/cli-shell.js";
import { toolCapabilityFor } from "../../hobo-mcp-server-contract/src/mcp-svid-auth.js";
import {
  assertSurfaceParity,
  createFixtureMcpGateway,
  createHoboMcpGatewayServer,
  createRateLimiter,
  DOCUMENTED_MCP_TOOLS,
  MCP_RATE_LIMIT_ERROR,
} from "../src/hobo-mcp-server.js";
import { isJsonNumber } from "../src/json.js";


const identity = { kind: "agent", id: "agent:ops", tenantId: "tenant:acme" };

describe("HOBO-634 @hobo/mcp gateway server POC", () => {
  it("NFR-004: every CLI capability is reachable via MCP with fresh operations manifests", () => {
    const result = assertSurfaceParity();
    assert.equal(result.ok, true);
    assert.equal(result.documentedTools, DOCUMENTED_MCP_TOOLS.length);
    assert.deepEqual(result.manifestPaths, ["/llms.txt", "/llms-full.txt", "/docs.json"]);
    assert.equal(result.cliVerbs, CANONICAL_VERBS.length);
  });

  it("FR-020: plan and deploy dispatch through the shared Gateway CLI call path", async () => {
    const calls = [];
    const cli = createHoboCli({
      contextFactory: async (request) => ({
        cwd: request.cwd,
        projectDir: request.cwd,
        identity,
        clients: { readApi: "gateway-read-api", runtime: "gateway-runtime" },
      }),
      commands: {
        plan: {
          run: async ({ verb, flags }) => {
            calls.push({ verb, flags });
            return { ok: true, status: "planned", code: "HOBO_PLAN_OK", message: "ok", data: { camp: flags.camp } };
          },
        },
        up: {
          run: async ({ verb, flags }) => {
            calls.push({ verb, flags });
            return { ok: true, status: "deployed", code: "HOBO_UP_OK", message: "ok", data: { camp: flags.camp } };
          },
        },
      },
    });

    const server = createFixtureMcpGateway({ cli });
    const planned = await server.callTool("plan", { cwd: "/repo", camp: "prod" }, { toolCallId: "t1" });
    const deployed = await server.callTool("deploy", { cwd: "/repo", camp: "prod" }, { toolCallId: "t2" });

    assert.equal(planned.ok, true);
    assert.equal(deployed.ok, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].verb, "plan");
    assert.equal(calls[0].flags.camp, "prod");
    assert.equal(calls[1].verb, "up");
    assert.equal(calls[1].flags.camp, "prod");
    assert.deepEqual(server.getGatewayCalls().map((call) => call.path), ["gateway->cli", "gateway->cli"]);
  });

  it("NFR-015: publishes llms.txt and docs.json for the operations surface", () => {
    const server = createFixtureMcpGateway();
    const manifests = server.operationsManifests();

    assert.match(manifests["llms.txt"], /^# HoBo operations/);
    assert.ok(manifests["llms-full.txt"].length > manifests["llms.txt"].length);
    const docs = JSON.parse(manifests["docs.json"]);
    assert.ok(docs.tools.length >= DOCUMENTED_MCP_TOOLS.length);
    assert.ok(docs.commands.length >= CANONICAL_VERBS.length);

    assert.equal(server.serveManifest("/llms.txt"), manifests["llms.txt"]);
    assert.equal(server.serveManifest("/docs.json"), manifests["docs.json"]);
  });

  it("NFR-019: flooding principal is throttled with typed error while legitimate traffic proceeds", async () => {
    const audit = [];
    const rateLimiter = createRateLimiter({
      perPrincipal: { windowMs: 60_000, maxRequests: 3 },
      perTenant: { windowMs: 60_000, maxRequests: 100 },
    });

    const floodServer = createFixtureMcpGateway({
      principalId: "agent:flooder",
      rateLimiter,
      auditSink: (event) => audit.push(event),
    });
    const legitServer = createFixtureMcpGateway({
      principalId: "agent:legit",
      rateLimiter,
    });

    const now = Date.UTC(2026, 6, 1, 12, 0, 0);
    for (let index = 0; index < 3; index += 1) {
      const result = await floodServer.callTool("plan", { cwd: "/repo" }, { toolCallId: `f${index}`, now });
      assert.equal(result.ok, true, `expected flood call ${index} to succeed`);
    }

    const throttled = await floodServer.callTool("plan", { cwd: "/repo" }, { toolCallId: "f-overflow", now });
    assert.equal(throttled.ok, false);
    assert.equal(throttled.throttled, true);
    assert.equal(throttled.error.code, MCP_RATE_LIMIT_ERROR);
    assert.ok(isJsonNumber(throttled.error.retryAfterMs));

    const legit = await legitServer.callTool("plan", { cwd: "/repo" }, { toolCallId: "legit-1", now });
    assert.equal(legit.ok, true);

    const throttleEvents = audit.filter((event) => event.type === "gateway.RateLimited");
    assert.equal(throttleEvents.length, 1);
    assert.equal(throttleEvents[0].data.principalId, "agent:flooder");
  });

  it("NFR-019: tenant-wide flood throttles colliding principals while other tenants proceed", async () => {
    const rateLimiter = createRateLimiter({
      perPrincipal: { windowMs: 60_000, maxRequests: 100 },
      perTenant: { windowMs: 60_000, maxRequests: 4 },
    });
    const now = Date.UTC(2026, 6, 1, 12, 0, 0);
    const tenantAOne = createFixtureMcpGateway({
      principalId: "agent:tenant-a-1",
      tenantId: "tenant:acme",
      rateLimiter,
    });
    const tenantATwo = createFixtureMcpGateway({
      principalId: "agent:tenant-a-2",
      tenantId: "tenant:acme",
      rateLimiter,
    });
    const tenantBOther = createFixtureMcpGateway({
      principalId: "agent:tenant-b-1",
      tenantId: "tenant:beta",
      rateLimiter,
    });

    for (const server of [tenantAOne, tenantATwo, tenantAOne, tenantATwo]) {
      const result = await server.callTool("plan", { cwd: "/repo" }, { toolCallId: `tenant-a-${Math.random()}`, now });
      assert.equal(result.ok, true);
    }

    const tenantOverflow = await tenantAOne.callTool("plan", { cwd: "/repo" }, { toolCallId: "tenant-a-overflow", now });
    assert.equal(tenantOverflow.ok, false);
    assert.equal(tenantOverflow.error.code, MCP_RATE_LIMIT_ERROR);

    const otherTenant = await tenantBOther.callTool("plan", { cwd: "/repo" }, { toolCallId: "tenant-b-ok", now });
    assert.equal(otherTenant.ok, true);
  });

  it("adversarial: anonymous write tools fail closed before gateway dispatch", async () => {
    const server = createHoboMcpGatewayServer({
      verifySvid: async () => ({ ok: false, code: "SVID_INVALID", message: "no session" }),
    });

    const result = await server.callTool("deploy", { cwd: "/repo" });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "MCP_AUTH_REQUIRED");
    assert.equal(server.getGatewayCalls().length, 0);
  });

  it("adversarial: deploy denied when SVID lacks tool capability", async () => {
    const server = createHoboMcpGatewayServer({
      svidAssertion: "fixture",
      // Pin the auth clock before the SVID expiry so the scope check (not an
      // expiry check) is what fails; otherwise this rots once wall-clock
      // passes expiresAt, matching the fixed clock the fixture gateway uses.
      now: () => new Date("2026-07-01T12:00:00.000Z"),
      verifySvid: async () => ({
        ok: true,
        principal: identity,
        svid: { id: "spiffe://yard/acme/agent/ops", expiresAt: "2026-07-02T12:00:00.000Z" },
        scopes: [toolCapabilityFor("plan")],
      }),
    });

    const result = await server.callTool("deploy", { cwd: "/repo" }, { toolCallId: "deny-deploy" });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "MCP_SCOPE_DENIED");
  });

  it("lists documented core tools with stdio and http transports", () => {
    const server = createFixtureMcpGateway();
    const names = server.listTools().map((tool) => tool.name);

    for (const tool of ["list_bindles", "get_bindle", "plan", "deploy", "request_token", "get_drift"]) {
      assert.ok(names.includes(tool), `missing core tool ${tool}`);
    }

    assert.deepEqual(server.listTransports().map((t) => t.kind), ["stdio", "http"]);
  });

  it("architecture artifacts pin protobuf, CUE, Pact, and ADR boundaries", () => {
    const adr = readFileSync(new URL("../ADR.md", import.meta.url), "utf8");
    const proto = readFileSync(new URL("../architecture/s3_08_hobo_mcp_server_poc.proto", import.meta.url), "utf8");
    const cue = readFileSync(new URL("../architecture/s3_08_hobo_mcp_server_poc.cue", import.meta.url), "utf8");
    const pact = JSON.parse(
      readFileSync(new URL("../architecture/pacts/s3_08_hobo_mcp_server_poc.pact.json", import.meta.url), "utf8"),
    );

    for (const typeName of ["McpGatewayRateLimitDecision", "S308HoboMcpServerPocRecord"]) {
      assert.match(proto, new RegExp(`message ${typeName}`));
      assert.match(cue, new RegExp(`#${typeName}:`));
    }

    assert.equal(pact.consumer.name, "S308HoboMcpServerPocConsumer");
    assert.equal(pact.provider.name, "S308HoboMcpServerPocBoundary");
    assert.equal(pact.interactions[0].response.body.rateLimitCode, MCP_RATE_LIMIT_ERROR);
    assert.match(adr, /parse, don't validate/i);
    assert.match(adr, /Command/i);
    assert.match(adr, /Event/i);
    assert.match(adr, /Actor/i);
    assert.match(adr, /event store/i);
    assert.match(adr, /projection/i);
    assert.match(adr, /read store/i);
  });
});
