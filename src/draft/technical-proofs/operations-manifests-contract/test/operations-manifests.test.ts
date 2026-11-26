import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import { CANONICAL_VERBS } from "../../hobo-cli-shell-contract/src/cli-shell.js";
import { CLI_MCP_PARITY, MCP_TOOL_SPECS } from "../../hobo-mcp-server-contract/src/mcp-server-contract.js";
import {
  assertOperationsManifestFresh,
  findOperationRoute,
  generateOperationsManifests,
  serveOperationsManifest,
  validateDocsJson,
} from "../src/operations-manifests.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("generates llms.txt, llms-full.txt, and docs.json from canonical CLI and MCP surfaces", () => {
  const manifests = generateOperationsManifests({
    verbs: CANONICAL_VERBS,
    tools: MCP_TOOL_SPECS,
  });

  assert.match(manifests["llms.txt"], /HoBo operations surface/);
  assert.match(manifests["llms.txt"], /hobo up/);
  assert.match(manifests["llms.txt"], /MCP deploy/);
  assert.match(manifests["llms-full.txt"], /Canonical CLI verbs/);
  assert.match(manifests["llms-full.txt"], /MCP tools/);

  const docs = JSON.parse(manifests["docs.json"]);
  assert.equal(docs.schema, "hobo.operations.docs/v1");
  assert.deepEqual(docs.commands.map((command) => command.name), CANONICAL_VERBS.map((verb) => verb.name));
  assert.deepEqual(docs.tools.map((tool) => tool.name), MCP_TOOL_SPECS.map((tool) => tool.name));
  assert.deepEqual(
    Object.fromEntries(docs.commands.map((command) => [command.name, command.mcp])),
    Object.fromEntries(CANONICAL_VERBS.map((verb) => [verb.name, CLI_MCP_PARITY[verb.name] ?? null])),
  );
  for (const tool of docs.tools) {
    assert.equal(tool.inputSchema.type, "object", `${tool.name} input schema is published`);
    assert.equal(tool.outputSchema.type, "object", `${tool.name} output schema is published`);
  }

  assert.deepEqual(findOperationRoute(docs, "deploy"), {
    intent: "deploy",
    cli: "hobo up",
    mcp: "deploy",
    access: "write",
  });
  assert.deepEqual(findOperationRoute(docs, "request_token"), {
    intent: "request_token",
    cli: null,
    mcp: "request_token",
    access: "write",
  });
  assert.deepEqual(findOperationRoute(docs, "list_bindles"), {
    intent: "list_bindles",
    cli: null,
    mcp: "list_bindles",
    access: "read",
  });
  assert.deepEqual(findOperationRoute(docs, "rollback"), {
    intent: "rollback",
    cli: "hobo up --rollback",
    mcp: "rollback",
    access: "write",
  });
});

test("serves the generated operations manifests from stable well-known paths", () => {
  const manifests = generateOperationsManifests({
    verbs: CANONICAL_VERBS,
    tools: MCP_TOOL_SPECS,
  });

  assert.equal(serveOperationsManifest("/llms.txt", manifests), manifests["llms.txt"]);
  assert.equal(serveOperationsManifest("/llms-full.txt", manifests), manifests["llms-full.txt"]);
  assert.equal(serveOperationsManifest("/docs.json", manifests), manifests["docs.json"]);
  assert.throws(() => serveOperationsManifest("/human-docs.html", manifests), /Unknown operations manifest path/);
});

test("docs.json validates complete schemas and route fields", () => {
  const manifests = generateOperationsManifests({ verbs: CANONICAL_VERBS, tools: MCP_TOOL_SPECS });
  const parsed = JSON.parse(manifests["docs.json"]);

  assert.deepEqual(validateDocsJson(parsed), { ok: true, errors: [], warnings: [] });
  assert.deepEqual(
    validateDocsJson({
      ...parsed,
      routes: [{ cli: "hobo up", mcp: "deploy", access: "write" }],
    }),
    { ok: false, errors: ["routes entry missing intent"], warnings: [] },
  );
});

test("missing metadata is deterministic and visible instead of silently complete", () => {
  const tools = MCP_TOOL_SPECS.map((tool) =>
    tool.name === "tail_logs" ? { ...tool, description: "" } : tool,
  );
  const manifests = generateOperationsManifests({ verbs: CANONICAL_VERBS, tools });
  const parsed = JSON.parse(manifests["docs.json"]);
  const tailed = parsed.tools.find((tool) => tool.name === "tail_logs");

  assert.equal(tailed.description, "No description supplied; canonical metadata is incomplete.");
  assert.equal(tailed.metadataComplete, false);
  assert.deepEqual(tailed.metadataWarnings, ["description missing; deterministic fallback emitted"]);
  assert.deepEqual(validateDocsJson(parsed), {
    ok: true,
    errors: [],
    warnings: ["tail_logs metadata incomplete"],
  });
});

test("drift check fails when a CLI verb or MCP tool is added without regenerating", () => {
  const manifests = generateOperationsManifests({
    verbs: CANONICAL_VERBS,
    tools: MCP_TOOL_SPECS,
  });

  assert.deepEqual(assertOperationsManifestFresh({ manifests, verbs: CANONICAL_VERBS, tools: MCP_TOOL_SPECS }), {
    ok: true,
  });
  assert.throws(
    () =>
      assertOperationsManifestFresh({
        manifests,
        verbs: [...CANONICAL_VERBS, { name: "fleet", role: "diagnostics", summary: "Rejected stale verb" }],
        tools: MCP_TOOL_SPECS,
      }),
    /operations manifest drift.*fleet/,
  );
  assert.throws(
    () =>
      assertOperationsManifestFresh({
        manifests,
        verbs: CANONICAL_VERBS,
        tools: [...MCP_TOOL_SPECS, { name: "export_fleet", access: "read", description: "New tool", inputSchema: {}, outputSchema: {} }],
      }),
    /operations manifest drift.*export_fleet/,
  );
});

test("published manifests exclude internal-only tools and redact secret material", () => {
  const manifests = generateOperationsManifests({
    verbs: CANONICAL_VERBS,
    tools: [
      ...MCP_TOOL_SPECS,
      {
        name: "internal_dump_tokens",
        access: "read",
        internal: true,
        description: "Debug Bearer shh-secret-key and token output",
        inputSchema: {},
        outputSchema: {},
      },
      {
        name: "debug_public",
        access: "read",
        description: "Show credential Bearer abc123 but no secret values",
        inputSchema: {},
        outputSchema: {},
      },
    ],
  });

  const allContent = `${manifests["llms.txt"]}\n${manifests["llms-full.txt"]}\n${manifests["docs.json"]}`;
  assert.doesNotMatch(allContent, /internal_dump_tokens/);
  assert.doesNotMatch(allContent, /Bearer\s+\S+/);
  assert.doesNotMatch(allContent, /secret-key/);
  assert.match(allContent, /debug_public/);
});

test("generation is byte-stable and routeable without human docs", () => {
  const first = generateOperationsManifests({ verbs: CANONICAL_VERBS, tools: MCP_TOOL_SPECS });
  const second = generateOperationsManifests({ verbs: CANONICAL_VERBS, tools: MCP_TOOL_SPECS });
  const docs = JSON.parse(first["docs.json"]);

  assert.deepEqual(second, first);
  assert.deepEqual(findOperationRoute(docs, "logs"), {
    intent: "logs",
    cli: "hobo logs",
    mcp: "tail_logs",
    access: "read",
  });
  assert.deepEqual(findOperationRoute(docs, "heal"), {
    intent: "heal",
    cli: "hobo drift",
    mcp: "heal",
    access: "write",
  });
  assert.equal(findOperationRoute(docs, "unknown"), null);
});

test("checked-in generated manifests are fresh against the canonical surfaces", async () => {
  const manifests = Object.fromEntries(
    await Promise.all(
      ["llms.txt", "llms-full.txt", "docs.json"].map(async (name) => [
        name,
        await readFile(path.join(packageRoot, "generated", name), "utf8"),
      ]),
    ),
  );

  assert.deepEqual(assertOperationsManifestFresh({ manifests, verbs: CANONICAL_VERBS, tools: MCP_TOOL_SPECS }), {
    ok: true,
  });
});
