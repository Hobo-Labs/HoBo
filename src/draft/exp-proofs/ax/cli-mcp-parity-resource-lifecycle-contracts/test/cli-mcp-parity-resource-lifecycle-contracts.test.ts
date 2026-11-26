import assert from "node:assert/strict";
import { test } from "vitest";

import {
  CLI_MCP_PARITY_CONTRACT,
  REQUIRED_FIXTURE_CASES,
  REQUIRED_OPERATIONS,
  assertCliMcpParity,
  parseCliMcpParityContract,
  rejectScopeCreep,
} from "../src/cli-mcp-parity-resource-lifecycle-contracts.ts";

test("defines CLI and MCP contracts for the required resource lifecycle operations", () => {
  const contract = parseCliMcpParityContract(CLI_MCP_PARITY_CONTRACT);

  assert.equal(contract.issue, "HOBO-570");
  assert.equal(contract.phase, "M1");
  assert.deepEqual(
    contract.operations.map((operation) => operation.id),
    [...REQUIRED_OPERATIONS],
  );

  for (const operation of contract.operations) {
    assert.ok(operation.cli.synopsis.startsWith("hobo "), `${operation.id} needs CLI synopsis`);
    assert.ok(operation.mcp.toolName.startsWith("hobo."), `${operation.id} needs MCP tool`);
    assert.equal(operation.mcp.inputSchema.schemaId, operation.mcp.inputSchemaId);
    assert.ok(operation.mcp.inputSchema.fields.length > 0, `${operation.id} needs MCP input fields`);
    assert.ok(operation.cli.stdoutJsonSchemaId, `${operation.id} needs stdout JSON schema`);
    assert.ok(operation.cli.exitCodes.length >= 2, `${operation.id} needs success and failure exits`);
    assert.equal(operation.sharedCallPath, "gateway-command-path");
  }
});

test("keeps deploy, promote, and rollback as hobo up modes instead of standalone verbs", () => {
  const contract = parseCliMcpParityContract(CLI_MCP_PARITY_CONTRACT);
  const up = contract.operations.find((operation) => operation.id === "up");

  assert.ok(up);
  assert.deepEqual(up?.lifecycleModes, ["deploy", "promote", "rollback"]);
  assert.ok(up?.cli.flags.some((flag) => flag.name === "--camp"));
  assert.ok(up?.cli.flags.some((flag) => flag.name === "--to"));
  assert.ok(up?.cli.flags.some((flag) => flag.name === "--rollback"));
  assert.deepEqual(contract.forbiddenStandaloneVerbs, ["deploy", "promote", "rollback", "yard up"]);
});

test("models brownfield import and migration as inputs to plan and up", () => {
  const contract = parseCliMcpParityContract(CLI_MCP_PARITY_CONTRACT);
  const importFlow = contract.operations.find((operation) => operation.id === "import");
  const migrateFlow = contract.operations.find((operation) => operation.id === "migrate");

  assert.deepEqual(importFlow?.feeds, ["plan", "migrate"]);
  assert.equal(importFlow?.stateProduced, "resource.Adopted");
  assert.equal(migrateFlow?.consumesState, "resource.Adopted");
  assert.deepEqual(migrateFlow?.feeds, ["up"]);
  assert.deepEqual(migrateFlow?.migrationPhases, ["expand", "backfill", "contract"]);
});

test("pins MCP input fields for CLI flags and flow arguments", () => {
  const contract = parseCliMcpParityContract(CLI_MCP_PARITY_CONTRACT);
  const fieldsFor = (id: string) =>
    contract.operations.find((operation) => operation.id === id)?.mcp.inputSchema.fields ?? [];

  assert.deepEqual(
    fieldsFor("up").map((field) => [field.name, field.mapsToCliFlag, field.required]),
    [
      ["camp", "--camp", false],
      ["strategy", "--strategy", false],
      ["to", "--to", false],
      ["rollback", "--rollback", false],
      ["json", "--json", false],
    ],
  );
  assert.deepEqual(
    fieldsFor("import").map((field) => [field.name, field.required]),
    [
      ["provider", true],
      ["source", true],
      ["json", false],
    ],
  );
  assert.deepEqual(
    fieldsFor("migrate").map((field) => [field.name, field.required]),
    [
      ["migration", true],
      ["camp", true],
      ["adoptedResourceId", true],
      ["json", false],
    ],
  );
  assert.deepEqual(fieldsFor("logs").find((field) => field.name === "follow")?.mapsToCliFlag, "--follow");
});

test("fixtures cover success, blocked, stale, non-portable, and support-handoff outcomes", () => {
  const contract = parseCliMcpParityContract(CLI_MCP_PARITY_CONTRACT);
  const cases = contract.fixtures.map((fixture) => fixture.case);

  assert.deepEqual(cases, [...REQUIRED_FIXTURE_CASES]);
  for (const fixture of contract.fixtures) {
    assert.equal(fixture.proofMode, "reference-fixture");
    assert.ok(fixture.fixtureId.startsWith("hobo-570-"));
    assert.ok(fixture.cli.command.startsWith("hobo "));
    assert.ok(fixture.mcp.tool.startsWith("hobo."));
    assert.ok(fixture.result.code.length > 0);
    assert.ok(fixture.result.humanMessage.length > 0);
    assert.ok(fixture.result.remediation.length > 0);
  }
});

test("CLI transcript and MCP tool result stay semantically equivalent", () => {
  const contract = parseCliMcpParityContract(CLI_MCP_PARITY_CONTRACT);

  for (const fixture of contract.fixtures) {
    assert.deepEqual(assertCliMcpParity(fixture), {
      case: fixture.case,
      equivalent: true,
    });
  }

  const divergentFixture = {
    ...contract.fixtures[0],
    mcp: {
      ...contract.fixtures[0].mcp,
      result: {
        ...contract.fixtures[0].mcp.result,
        remediation: "Different operator action.",
      },
    },
  };

  assert.equal(assertCliMcpParity(divergentFixture).equivalent, false);

  const mismatchedInputFixture = {
    ...contract.fixtures[0],
    mcp: {
      ...contract.fixtures[0].mcp,
      input: {
        camp: "prod",
        json: true,
      },
    },
  };

  assert.equal(assertCliMcpParity(mismatchedInputFixture).equivalent, false);

  const mismatchedToolFixture = {
    ...contract.fixtures[0],
    mcp: {
      ...contract.fixtures[0].mcp,
      tool: "hobo.plan",
    },
  };

  assert.equal(assertCliMcpParity(mismatchedToolFixture).equivalent, false);
});

test("scope guard rejects production parser, live auth, live MCP server, dashboards, and invented verbs", () => {
  assert.throws(
    () => rejectScopeCreep("Build a production argument parser for hobo deploy."),
    /production argument parser is scope-out/,
  );
  assert.throws(
    () => rejectScopeCreep("Wire the live auth broker and live MCP server."),
    /live auth or MCP runtime is scope-out/,
  );
  assert.throws(
    () => rejectScopeCreep("Render dashboard views and introduce hobo promote."),
    /dashboard or invented lifecycle verb is scope-out/,
  );
  assert.throws(
    () => rejectScopeCreep("Ship hobo rollback as a standalone command."),
    /dashboard or invented lifecycle verb is scope-out/,
  );
});
