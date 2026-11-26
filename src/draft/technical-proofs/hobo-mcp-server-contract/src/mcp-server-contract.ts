import { CLI_COMMAND_SCHEMAS, createHoboCli } from "../../hobo-cli-shell-contract/src/cli-shell.js";
import { createRequestTokenTool } from "../../token-broker-skeleton-contract/src/token-broker-skeleton.js";
import { isJsonString, isJsonBoolean, isJsonObject } from "./json.js";


export const DOCUMENTED_MCP_TOOLS = [
  "list_bindles",
  "get_bindle",
  "plan",
  "deploy",
  "promote",
  "rollback",
  "destroy",
  "inspect_run",
  "tail_logs",
  "search_registry",
  "request_token",
  "get_drift",
  "heal",
];

export const CLI_MCP_PARITY = Object.freeze({
  up: "deploy",
  down: "destroy",
  dev: "dev",
  new: "new",
  login: "login",
  claim: "claim",
  plan: "plan",
  verify: "verify",
  "can-deploy": "can_deploy",
  inspect: "inspect_run",
  logs: "tail_logs",
  doctor: "doctor",
  codegen: "codegen",
  build: "build",
  collect: "collect",
  stub: "stub",
  drift: "get_drift",
  add: "add",
  registry: "search_registry",
  import: "import",
  generate: "generate",
  sandbox: "sandbox",
  test: "test",
  attest: "attest",
  erase: "erase",
  derivative: "derivative",
  runbook: "runbook",
});

const emptySchema = schema();
const cwdSchema = schema({
  cwd: { type: "string" },
  camp: { type: "string" },
  args: { type: "array", items: { type: "string" } },
});
const idSchema = schema({ bindleId: { type: "string" } }, ["bindleId"]);
const runSchema = schema({ runId: { type: "string" } }, ["runId"]);
const capabilitySchema = schema({ capability: { type: "string" } }, ["capability"]);
const bindleListOutputSchema = schema({ bindles: { type: "array", items: { type: "object" } } });
const bindleOutputSchema = schema({ bindleId: { type: "string" }, topology: { type: "object" } });
const projectionOutputSchema = schema({ runId: { type: "string" }, timeline: { type: "array", items: { type: "object" } } });
const logTailOutputSchema = schema({ runId: { type: "string" }, complete: { type: "boolean" } });
const registryOutputSchema = schema({ capability: { type: "string" }, results: { type: "array", items: { type: "object" } } });
const driftOutputSchema = schema({ drift: { type: "array", items: { type: "object" } } });
const cliOutputSchema = schema({
  cli: { type: "object" },
  data: { type: "object" },
});
const tokenSchema = schema(
  {
    requestId: { type: "string" },
    provider: { type: "string" },
    scope: { type: "object" },
    svidScope: { type: "array" },
  },
  ["requestId", "provider", "scope", "svidScope"],
);
const tokenOutputSchema = schema({
  requestId: { type: "string" },
  provider: { type: "string" },
  credential: { type: "object" },
  events: { type: "array", items: { type: "object" } },
});

export const MCP_TOOL_SPECS = Object.freeze([
  tool("list_bindles", "Discover Bindles visible to the current principal.", "read", emptySchema, {
    outputSchema: bindleListOutputSchema,
  }),
  tool("get_bindle", "Return one Bindle topology by id.", "read", idSchema, { outputSchema: bindleOutputSchema }),
  tool("plan", "Dry-run hobo plan through the shared CLI call path.", "read", cwdSchema, { cliVerb: "plan" }),
  tool("deploy", "Converge a topology through hobo up.", "write", cwdSchema, { cliVerb: "up" }),
  tool("promote", "Promote by converging a target Camp through hobo up.", "write", cwdSchema, { cliVerb: "up" }),
  tool("rollback", "Rollback by invoking hobo up --rollback.", "write", cwdSchema, { cliVerb: "up", cliArgs: ["--rollback"] }),
  tool("destroy", "Tear down a topology through hobo down.", "write", cwdSchema, { cliVerb: "down", destructive: true }),
  tool("inspect_run", "Read RunView or DeploymentView projection data.", "read", runSchema, {
    cliVerb: "inspect",
    outputSchema: projectionOutputSchema,
  }),
  tool("tail_logs", "Stream runtime log progress for a run or resource.", "read", runSchema, {
    cliVerb: "logs",
    streaming: true,
    outputSchema: logTailOutputSchema,
  }),
  tool("search_registry", "Find providers or listings by capability.", "read", capabilitySchema, {
    cliVerb: "registry",
    outputSchema: registryOutputSchema,
  }),
  tool("request_token", "Broker a scoped provider token through the token-broker seam.", "write", tokenSchema, {
    outputSchema: tokenOutputSchema,
  }),
  tool("get_drift", "Read drift status for a Camp or resource.", "read", cwdSchema, {
    cliVerb: "drift",
    outputSchema: driftOutputSchema,
  }),
  tool("heal", "Request governed drift reconciliation.", "write", cwdSchema, { cliVerb: "drift" }),
  tool("dev", "Run hobo dev through the shared CLI call path.", "write", cwdSchema, { cliVerb: "dev" }),
  tool("new", "Scaffold a new HoBo program through hobo new.", "write", cwdSchema, { cliVerb: "new" }),
  tool("login", "Start the hobo login identity flow.", "write", cwdSchema, { cliVerb: "login" }),
  tool("claim", "Bind an anonymous deployment through hobo claim.", "write", cwdSchema, { cliVerb: "claim" }),
  tool("verify", "Run hobo verify through the shared CLI call path.", "read", cwdSchema, { cliVerb: "verify" }),
  tool("can_deploy", "Run hobo can-deploy compatibility checks.", "read", cwdSchema, { cliVerb: "can-deploy" }),
  tool("doctor", "Run hobo doctor diagnostics.", "read", cwdSchema, { cliVerb: "doctor" }),
  tool("codegen", "Run hobo codegen through the shared CLI call path.", "write", cwdSchema, { cliVerb: "codegen" }),
  tool("build", "Run hobo build through the shared CLI call path.", "write", cwdSchema, { cliVerb: "build" }),
  tool("collect", "Run hobo collect through the shared CLI call path.", "read", cwdSchema, { cliVerb: "collect" }),
  tool("stub", "Run hobo stub through the shared CLI call path.", "write", cwdSchema, { cliVerb: "stub" }),
  tool("add", "Install a provider or listing through hobo add.", "write", cwdSchema, { cliVerb: "add" }),
  tool("import", "Adopt an existing estate through hobo import.", "write", cwdSchema, { cliVerb: "import" }),
  tool("generate", "Request provider generation through hobo generate.", "write", cwdSchema, { cliVerb: "generate" }),
  tool("sandbox", "Run a contract-backed isolated lane through hobo sandbox.", "write", cwdSchema, { cliVerb: "sandbox" }),
  tool("test", "Run the sandbox test lane through hobo test.", "write", cwdSchema, { cliVerb: "test" }),
  tool("attest", "Produce signed evidence exports through hobo attest.", "write", cwdSchema, { cliVerb: "attest" }),
  tool("erase", "Request crypto-shred erasure through hobo erase.", "write", cwdSchema, { cliVerb: "erase", destructive: true }),
  tool("derivative", "Manage derived HoBo implementations through hobo derivative.", "write", cwdSchema, { cliVerb: "derivative" }),
  tool("runbook", "Execute or replay runbooks through hobo runbook.", "write", cwdSchema, { cliVerb: "runbook" }),
]);

export function createHoboMcpServer(options = {}) {
  const specs = options.tools ?? MCP_TOOL_SPECS;
  const specByName = new Map(specs.map((spec) => [spec.name, spec]));
  const identity = options.identity ?? null;
  const cli = options.cli ?? createFixtureCli(identity);
  const handlers = options.handlers ?? {};
  const tokenTool = options.tokenBroker ? createRequestTokenTool(options.tokenBroker) : null;

  return Object.freeze({
    listTools() {
      return specs.map(publicTool);
    },

    listTransports() {
      return [
        { kind: "stdio", framing: "json-rpc-2.0" },
        { kind: "http", framing: "json-rpc-2.0", path: "/mcp" },
      ];
    },

    async callTool(name, input = {}, callOptions = {}) {
      const spec = specByName.get(name);
      if (!spec) {
        return failure(name, "MCP_TOOL_UNKNOWN", `Unknown MCP tool "${name}".`);
      }

      const validation = validateInput(spec.inputSchema, input);
      if (!validation.ok) {
        return failure(name, "MCP_INPUT_INVALID", validation.message);
      }

      if (spec.access === "write" && !identity) {
        return failure(name, "MCP_AUTH_REQUIRED", `${name} requires an authenticated principal.`);
      }

      try {
        const context = {
          identity,
          emitProgress: (event) => callOptions.onProgress?.({ tool: name, ...event }),
        };
        if (handlers[name]) {
          const data = await handlers[name](input, context);
          return success(name, data);
        }
        if (name === "request_token") {
          if (!tokenTool) {
            return failure(name, "MCP_TOOL_UNBOUND", "request_token requires a token broker.");
          }
          return success(name, await tokenTool.invoke({ ...input, subject: identity }));
        }
        if (spec.cliVerb) {
          return callCliTool({ cli, spec, input, emitProgress: context.emitProgress });
        }
        return success(name, defaultDataFor(name, input));
      } catch (error) {
        return failure(name, "MCP_TOOL_FAILED", error.message || "Tool failed.");
      }
    },
  });
}

export function assertCliParity(toolSpecs, canonicalVerbs, cliSchemas = CLI_COMMAND_SCHEMAS) {
  const toolNames = new Set(toolSpecs.map((spec) => spec.name));
  const specByName = new Map(toolSpecs.map((spec) => [spec.name, spec]));
  const missing = [];
  const schemaDrift = [];
  const mappings = {};

  for (const verb of canonicalVerbs) {
    const toolName = CLI_MCP_PARITY[verb.name];
    mappings[verb.name] = toolName;
    if (!toolName || !toolNames.has(toolName)) {
      missing.push(verb.name);
      continue;
    }

    const cliInputSchema = cliSchemas[verb.name]?.inputSchema ?? cliSchemas[verb.name];
    const toolSpec = specByName.get(toolName);
    if (!cliInputSchema || !sameSchema(toolSpec.inputSchema, cliInputSchema)) {
      schemaDrift.push({ verb: verb.name, tool: toolName });
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing MCP parity for CLI verb "${missing[0]}".`);
  }
  if (schemaDrift.length > 0) {
    const drift = schemaDrift[0];
    throw new Error(`Schema drift between CLI verb "${drift.verb}" and MCP tool "${drift.tool}".`);
  }

  return { ok: true, missing, schemaDrift, mappings };
}

function tool(name, description, access, inputSchema, options = {}) {
  return Object.freeze({
    name,
    description,
    access,
    inputSchema,
    outputSchema: options.outputSchema ?? (options.cliVerb ? cliOutputSchema : emptySchema),
    cliVerb: options.cliVerb ?? null,
    cliArgs: options.cliArgs ?? [],
    streaming: options.streaming ?? false,
    annotations: {
      readOnlyHint: access === "read",
      destructiveHint: options.destructive ?? false,
    },
  });
}

function schema(properties = {}, required = []) {
  return Object.freeze({
    type: "object",
    properties,
    required,
    additionalProperties: true,
  });
}

function publicTool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    access: spec.access,
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema,
    annotations: spec.annotations,
  };
}

function createFixtureCli(identity) {
  return createHoboCli({
    contextFactory: async (request) => ({
      cwd: request.cwd,
      projectDir: request.cwd,
      identity,
      clients: { readApi: "mcp-fixture-read-api", runtime: "mcp-fixture-runtime" },
    }),
  });
}

async function callCliTool({ cli, spec, input, emitProgress }) {
  const argv = [spec.cliVerb, "--json", ...campArgs(input), ...spec.cliArgs, ...toolArgs(input)];
  const result = await cli.run(argv, {
    cwd: input.cwd ?? process.cwd(),
    onProgress: (event) => emitProgress?.({ cliVerb: spec.cliVerb, ...event }),
  });

  if (result.exitCode !== 0) {
    return failure(spec.name, "MCP_CLI_FAILED", result.stderr.trim() || `hobo ${spec.cliVerb} failed.`);
  }

  const envelope = JSON.parse(result.stdout);
  return {
    ok: envelope.ok !== false,
    tool: spec.name,
    cli: {
      verb: envelope.verb,
      status: envelope.status,
      code: envelope.code,
      message: envelope.message,
      data: envelope.data,
    },
    data: envelope.data,
  };
}

function campArgs(input) {
  return input.camp ? ["--camp", input.camp] : [];
}

function toolArgs(input) {
  const args = [...(input.args ?? [])];
  for (const field of ["bindleId", "runId", "capability"]) {
    if (input[field] && !args.includes(input[field])) {
      args.unshift(input[field]);
    }
  }
  return args;
}

function validateInput(inputSchema, input) {
  if (!isPlainObject(input)) {
    return { ok: false, message: "input must be an object" };
  }

  for (const field of inputSchema.required ?? []) {
    if (input[field] === undefined) {
      return { ok: false, message: `${field} is required` };
    }
  }

  for (const [field, definition] of Object.entries(inputSchema.properties ?? {})) {
    if (input[field] === undefined) {
      continue;
    }
    if (!matchesType(input[field], definition)) {
      return { ok: false, message: `${field} must be ${typeDescription(definition)}` };
    }
  }

  return { ok: true };
}

function matchesType(value, definition) {
  switch (definition.type) {
    case "array":
      return Array.isArray(value) && (!definition.items || value.every((entry) => matchesType(entry, definition.items)));
    case "object":
      return isPlainObject(value);
    case "string":
      return isJsonString(value) && value.length > 0;
    case "boolean":
      return isJsonBoolean(value);
    default:
      return true;
  }
}

function typeDescription(definition) {
  return definition.type === "array" && definition.items
    ? `array of ${definition.items.type}`
    : `a ${definition.type}`;
}

function sameSchema(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function defaultDataFor(name, input) {
  switch (name) {
    case "list_bindles":
      return { bindles: [] };
    case "get_bindle":
      return { bindleId: input.bindleId, topology: null };
    case "inspect_run":
      return { runId: input.runId, timeline: [] };
    case "tail_logs":
      return { runId: input.runId, complete: true };
    case "search_registry":
      return { capability: input.capability, results: [] };
    case "get_drift":
      return { drift: [] };
    default:
      return {};
  }
}

function success(toolName, data) {
  return { ok: data?.ok ?? true, tool: toolName, data };
}

function failure(toolName, code, message) {
  return {
    ok: false,
    tool: toolName,
    error: { code, message },
  };
}

function isPlainObject(value) {
  return (
    value !== null &&
    isJsonObject(value) &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
