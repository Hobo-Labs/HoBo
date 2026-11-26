import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { CANONICAL_VERBS, CLI_COMMAND_SCHEMAS, createHoboCli } from "../../hobo-cli-shell-contract/src/cli-shell.js";
import {
  assertCliParity,
  createHoboMcpServer,
  DOCUMENTED_MCP_TOOLS,
  MCP_TOOL_SPECS,
} from "../src/mcp-server-contract.js";
import { isJsonBoolean } from "../src/json.js";

const identity = { kind: "agent", id: "agent:ops" };

describe("HoBo MCP server contract", () => {
  it("lists the documented operations surface with valid schemas and access annotations", () => {
    const server = createHoboMcpServer({ identity });
    const tools = server.listTools();
    const toolNames = tools.map((tool) => tool.name);

    for (const documented of DOCUMENTED_MCP_TOOLS) {
      assert.ok(toolNames.includes(documented), `missing documented tool ${documented}`);
    }

    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, "object", `${tool.name} schema must be object-shaped`);
      assert.equal(tool.outputSchema.type, "object", `${tool.name} output schema must be object-shaped`);
      assert.ok(tool.description.length > 0, `${tool.name} needs a routeable description`);
      assert.ok(["read", "write"].includes(tool.access), `${tool.name} access must be explicit`);
      assert.equal(isJsonBoolean(tool.annotations.readOnlyHint), true);
      assert.equal(isJsonBoolean(tool.annotations.destructiveHint), true);
    }

    assert.equal(tools.find((tool) => tool.name === "plan").access, "read");
    assert.equal(tools.find((tool) => tool.name === "deploy").access, "write");
    assert.equal(tools.find((tool) => tool.name === "destroy").annotations.destructiveHint, true);
    assert.deepEqual(server.listTransports().map((transport) => transport.kind), ["stdio", "http"]);
  });

  it("maps plan and deploy to the same shared CLI call path as hobo plan/up", async () => {
    const calls = [];
    const progress = [];
    const cli = createHoboCli({
      contextFactory: async (request) => ({
        cwd: request.cwd,
        projectDir: request.cwd,
        identity,
        clients: { readApi: "fixture-read-api", runtime: "fixture-runtime" },
      }),
      commands: {
        plan: {
          run: async ({ context, flags, args, verb }) => {
            calls.push({ verb, flags, args });
            return {
              ok: true,
              status: "planned",
              code: "HOBO_PLAN_OK",
              message: "plan ready",
              data: { projectDir: context.projectDir, camp: flags.camp },
            };
          },
        },
        up: {
          run: async ({ context, flags, args, verb, emitProgress }) => {
            calls.push({ verb, flags, args });
            emitProgress({ phase: "deploy", message: "up started" });
            emitProgress({ phase: "deploy", message: "up converged" });
            return {
              ok: true,
              status: "deployed",
              code: "HOBO_UP_OK",
              message: "up converged",
              data: { projectDir: context.projectDir, camp: flags.camp, args },
            };
          },
        },
      },
    });
    const server = createHoboMcpServer({ cli, identity });

    const planned = await server.callTool("plan", { cwd: "C:\\repo\\app", camp: "prod" });
    const deployed = await server.callTool(
      "deploy",
      { cwd: "C:\\repo\\app", camp: "prod", args: ["--strategy", "canary"] },
      { onProgress: (event) => progress.push(event) },
    );
    const cliPlan = await cli.run(["plan", "--json", "--camp", "prod"], { cwd: "C:\\repo\\app" });
    const cliUp = await cli.run(["up", "--json", "--camp", "prod", "--strategy", "canary"], { cwd: "C:\\repo\\app" });

    assert.equal(planned.ok, true);
    assert.equal(planned.cli.verb, "plan");
    assert.equal(planned.cli.status, JSON.parse(cliPlan.stdout).status);
    assert.equal(deployed.ok, true);
    assert.equal(deployed.cli.verb, "up");
    assert.equal(deployed.cli.status, JSON.parse(cliUp.stdout).status);
    assert.deepEqual(calls.map((call) => call.verb), ["plan", "up", "plan", "up"]);
    assert.deepEqual(
      progress.map((event) => [event.tool, event.cliVerb, event.message]),
      [
        ["deploy", "up", "up started"],
        ["deploy", "up", "up converged"],
      ],
    );
  });

  it("returns projection data and streams progress for inspect_run and tail_logs", async () => {
    const progress = [];
    const server = createHoboMcpServer({
      identity,
      handlers: {
        inspect_run: async ({ runId }) => ({
          runId,
          status: "running",
          timeline: [{ seq: 1, type: "deployment.Planned" }],
        }),
        tail_logs: async ({ runId }, context) => {
          context.emitProgress({ runId, line: "deploy started" });
          context.emitProgress({ runId, line: "deploy converged" });
          return { runId, complete: true };
        },
      },
    });

    const inspected = await server.callTool("inspect_run", { runId: "run-42" });
    const tailed = await server.callTool("tail_logs", { runId: "run-42" }, { onProgress: (event) => progress.push(event) });

    assert.deepEqual(inspected.data.timeline, [{ seq: 1, type: "deployment.Planned" }]);
    assert.equal(tailed.ok, true);
    assert.equal(tailed.data.complete, true);
    assert.deepEqual(progress.map((event) => event.line), ["deploy started", "deploy converged"]);
  });

  it("pins CLI-to-MCP parity so a new CLI verb cannot silently lack an agent tool", () => {
    const parity = assertCliParity(MCP_TOOL_SPECS, CANONICAL_VERBS);

    assert.equal(parity.ok, true);
    assert.deepEqual(parity.missing, []);
    assert.deepEqual(parity.schemaDrift, []);
    assert.equal(parity.mappings.up, "deploy");
    assert.equal(parity.mappings.down, "destroy");
    assert.equal(parity.mappings.logs, "tail_logs");

    assert.throws(
      () => assertCliParity(MCP_TOOL_SPECS.filter((tool) => tool.name !== "plan"), CANONICAL_VERBS),
      /Missing MCP parity for CLI verb "plan"/,
    );

    const driftedCliSchemas = JSON.parse(JSON.stringify(CLI_COMMAND_SCHEMAS));
    delete driftedCliSchemas.plan.properties.camp;
    assert.throws(
      () => assertCliParity(MCP_TOOL_SPECS, CANONICAL_VERBS, driftedCliSchemas),
      /Schema drift between CLI verb "plan" and MCP tool "plan"/,
    );
  });

  it("rejects malformed input with a structured error instead of crashing", async () => {
    const server = createHoboMcpServer({ identity });

    const result = await server.callTool("get_bindle", {});

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "MCP_INPUT_INVALID");
    assert.match(result.error.message, /bindleId is required/);
  });

  it("fails closed for anonymous mutation tools but permits read-only tools", async () => {
    const server = createHoboMcpServer();

    const planned = await server.callTool("plan", { cwd: "C:\\repo\\app" });
    const deployed = await server.callTool("deploy", { cwd: "C:\\repo\\app" });

    assert.equal(planned.ok, true);
    assert.equal(deployed.ok, false);
    assert.equal(deployed.error.code, "MCP_AUTH_REQUIRED");
    assert.match(deployed.error.message, /requires an authenticated principal/);
  });

  it("routes request_token through the token broker seam", async () => {
    const requests = [];
    const server = createHoboMcpServer({
      identity,
      tokenBroker: {
        async requestToken(request) {
          requests.push(request);
          return { ok: true, requestId: request.requestId, provider: request.provider };
        },
      },
    });

    const result = await server.callTool("request_token", {
      requestId: "req-1",
      provider: "acme-cloud",
      scope: { port: "database", resource: "shop.db", action: "read" },
      svidScope: [{ port: "database", resource: "shop.db", actions: ["read"] }],
    });

    assert.equal(result.ok, true);
    assert.equal(result.data.provider, "acme-cloud");
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].subject, identity);
  });
});
