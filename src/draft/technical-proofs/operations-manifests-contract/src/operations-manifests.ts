import { CLI_MCP_PARITY } from "../../hobo-mcp-server-contract/src/mcp-server-contract.js";

export const OPERATIONS_DOCS_SCHEMA = "hobo.operations.docs/v1";

const manifestPaths = Object.freeze({
  "/llms.txt": "llms.txt",
  "/llms-full.txt": "llms-full.txt",
  "/docs.json": "docs.json",
});

export function generateOperationsManifests({ verbs, tools }) {
  const docs = createDocsJson({ verbs, tools });

  return Object.freeze({
    "llms.txt": renderLlmsTxt(docs),
    "llms-full.txt": renderLlmsFullTxt(docs),
    "docs.json": `${stableJson(docs)}\n`,
  });
}

export function serveOperationsManifest(requestPath, manifests) {
  const manifestKey = manifestPaths[requestPath];
  if (!manifestKey) {
    throw new Error(`Unknown operations manifest path: ${requestPath}`);
  }
  return manifests[manifestKey];
}

export function validateDocsJson(docs) {
  const errors = [];
  const warnings = [];

  if (!isObjectRecord(docs)) {
    return { ok: false, errors: ["docs.json must be an object"], warnings };
  }
  if (docs.schema !== OPERATIONS_DOCS_SCHEMA) {
    errors.push(`schema must be ${OPERATIONS_DOCS_SCHEMA}`);
  }
  if (!Array.isArray(docs.commands)) {
    errors.push("commands must be an array");
  }
  if (!Array.isArray(docs.tools)) {
    errors.push("tools must be an array");
  }
  if (!Array.isArray(docs.routes)) {
    errors.push("routes must be an array");
  }

  for (const [collectionName, collection] of [
    ["commands", docs.commands ?? []],
    ["tools", docs.tools ?? []],
    ["routes", docs.routes ?? []],
  ]) {
    for (const entry of collection) {
      if (!isObjectRecord(entry)) {
        errors.push(`${collectionName} entries must be objects`);
        continue;
      }
      if (!entry.name && collectionName !== "routes") {
        errors.push(`${collectionName} entry missing name`);
      }
      if (collectionName === "commands") {
        requireStringFields(errors, "commands", entry, ["command", "summary"]);
      }
      if (collectionName === "tools") {
        requireStringFields(errors, "tools", entry, ["access", "description"]);
        requireObjectFields(errors, "tools", entry, ["inputSchema", "outputSchema"]);
        if (entry.metadataComplete === false) {
          warnings.push(`${entry.name} metadata incomplete`);
        }
      }
      if (collectionName === "routes") {
        requireStringFields(errors, "routes", entry, ["intent", "mcp", "access"]);
        if (entry.cli !== null) {
          requireStringFields(errors, "routes", entry, ["cli"]);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function assertOperationsManifestFresh({ manifests, verbs, tools }) {
  const expected = generateOperationsManifests({ verbs, tools });
  const drift = [];

  for (const key of Object.keys(expected)) {
    if (manifests[key] !== expected[key]) {
      drift.push(key);
    }
  }

  if (drift.length > 0) {
    const docs = JSON.parse(expected["docs.json"]);
    const commandNames = docs.commands.map((command) => command.name).join(", ");
    const toolNames = docs.tools.map((tool) => tool.name).join(", ");
    throw new Error(
      `operations manifest drift in ${drift.join(", ")}; regenerate for commands [${commandNames}] and tools [${toolNames}]`,
    );
  }

  return { ok: true };
}

export function findOperationRoute(docs, intent) {
  return docs.routes.find((route) => route.intent === intent) ?? null;
}

function createDocsJson({ verbs, tools }) {
  const publicTools = tools.filter(isPublicTool);
  const toolsByName = new Map(publicTools.map((tool) => [tool.name, tool]));

  const commands = verbs.map((verb) => ({
    name: verb.name,
    role: verb.role,
    summary: sanitizeText(verb.summary),
    command: `hobo ${verb.name}`,
    mcp: CLI_MCP_PARITY[verb.name] ?? null,
  }));

  const normalizedTools = publicTools.map((tool) => ({
    name: tool.name,
    access: tool.access ?? "read",
    description: safeDescription(tool.description),
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    cliVerb: tool.cliVerb,
    cliArgs: tool.cliArgs ?? [],
    streaming: tool.streaming ?? false,
    readOnly: tool.annotations?.readOnlyHint ?? tool.access === "read",
    destructive: tool.annotations?.destructiveHint ?? false,
    metadataComplete: hasDescription(tool.description),
    metadataWarnings: metadataWarningsFor(tool),
  }));

  return {
    schema: OPERATIONS_DOCS_SCHEMA,
    generatedBy: "HOBO-176 operations-manifest contract",
    commands,
    tools: normalizedTools,
    routes: createRoutes(commands, toolsByName),
  };
}

function createRoutes(commands, toolsByName) {
  const cliRoutes = commands
    .filter((command) => command.mcp && toolsByName.has(command.mcp))
    .map((command) => ({
      intent: command.name,
      cli: command.command,
      mcp: command.mcp,
      access: toolsByName.get(command.mcp).access ?? "read",
    }));
  const routesByMcp = new Map(cliRoutes.map((route) => [route.mcp, route]));
  const mcpOnlyRoutes = Array.from(toolsByName.values())
    .filter((tool) => !routesByMcp.has(tool.name))
    .map((tool) => ({
      intent: tool.name,
      cli: tool.cliVerb ? cliCommandForTool(tool) : null,
      mcp: tool.name,
      access: tool.access ?? "read",
    }));
  const routes = [...cliRoutes, ...mcpOnlyRoutes];
  const upRoute = routes.find((route) => route.intent === "up");
  if (upRoute) {
    routes.unshift({ ...upRoute, intent: "deploy" });
  }
  return routes;
}

function cliCommandForTool(tool) {
  return ["hobo", tool.cliVerb, ...(tool.cliArgs ?? [])].join(" ");
}

function renderLlmsTxt(docs) {
  const priorityRoutes = ["up", "plan", "inspect", "logs", "doctor", "registry"]
    .map((intent) => findOperationRoute(docs, intent))
    .filter(Boolean)
    .map((route) => `- ${routeSummary(route.intent)}: ${route.cli} (MCP ${route.mcp})`);

  return [
    "# HoBo operations surface",
    "",
    "Use these machine-readable operations manifests before scraping human docs.",
    "",
    "Primary routes:",
    ...priorityRoutes,
    "",
    "Manifests:",
    "- /llms.txt: concise operations index",
    "- /llms-full.txt: full CLI and MCP reference",
    "- /docs.json: structured schema hobo.operations.docs/v1",
    "",
  ].join("\n");
}

function renderLlmsFullTxt(docs) {
  return [
    "# HoBo full operations reference",
    "",
    "Canonical CLI verbs:",
    ...docs.commands.map((command) => `- ${command.command}: ${command.summary}`),
    "",
    "MCP tools:",
    ...docs.tools.map((tool) => `- ${tool.name} (${tool.access}): ${tool.description}`),
    "",
    "Routes:",
    ...docs.routes.map((route) => `- ${route.intent}: ${routeSurface(route)} (${route.access})`),
    "",
  ].join("\n");
}

function routeSurface(route) {
  return route.cli ? `${route.cli} -> MCP ${route.mcp}` : `MCP ${route.mcp}`;
}

function routeSummary(intent) {
  switch (intent) {
    case "up":
      return "deploy";
    case "registry":
      return "search registry";
    default:
      return intent;
  }
}

function isPublicTool(tool) {
  if (tool.internal === true) {
    return false;
  }
  return !tool.name.startsWith("internal_");
}

function safeDescription(description) {
  const text = hasDescription(description) ? description : "No description supplied; canonical metadata is incomplete.";
  return sanitizeText(text);
}

function hasDescription(description) {
  return isString(description) && description.trim().length > 0;
}

function metadataWarningsFor(tool) {
  const warnings = [];
  if (!hasDescription(tool.description)) {
    warnings.push("description missing; deterministic fallback emitted");
  }
  return warnings;
}

function requireStringFields(errors, collectionName, entry, fields) {
  for (const field of fields) {
    if (!isString(entry[field]) || !entry[field].trim()) {
      errors.push(`${collectionName} entry missing ${field}`);
    }
  }
}

function requireObjectFields(errors, collectionName, entry, fields) {
  for (const field of fields) {
    if (!isObjectRecord(entry[field])) {
      errors.push(`${collectionName} entry missing ${field}`);
    }
  }
}

function sanitizeText(text) {
  return text
    .replace(/Bearer\s+\S+/gi, "[redacted bearer]")
    .replace(/[A-Z0-9_]*(SECRET|TOKEN|KEY)[A-Z0-9_]*\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/shh-secret-key/gi, "[redacted]")
    .trim();
}

function stableJson(value) {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (isObjectRecord(value) && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}

function isObjectRecord(value) {
  return value !== null && Object.prototype.toString.call(value) === "[object Object]";
}

function isString(value) {
  return Object.prototype.toString.call(value) === "[object String]";
}
