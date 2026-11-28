import { type JsonObject } from "./json.js";
export const REQUIRED_OPERATIONS = [
  "collect",
  "plan",
  "up",
  "inspect",
  "logs",
  "doctor",
  "import",
  "migrate",
] as const;

export const REQUIRED_FIXTURE_CASES = [
  "successful-deploy",
  "blocked-deploy",
  "stale-projection",
  "non-portable-edge",
  "support-handoff",
] as const;

type OperationId = (typeof REQUIRED_OPERATIONS)[number];
type FixtureCase = (typeof REQUIRED_FIXTURE_CASES)[number];
type ProofMode = "reference-fixture" | "simulated-reference" | "design-record";
type SharedCallPath = "gateway-command-path";
type FeedTarget = "plan" | "migrate" | "up";
type MigrationPhase = "expand" | "backfill" | "contract";
type LifecycleMode = "deploy" | "promote" | "rollback";
type McpInputType = "string" | "boolean" | "enum";

type CliFlag = {
  readonly name: string;
  readonly purpose: string;
  readonly required: boolean;
};

type CliContract = {
  readonly synopsis: string;
  readonly flags: readonly CliFlag[];
  readonly stdin: "none" | "json";
  readonly stdoutJsonSchemaId: string;
  readonly stderr: readonly string[];
  readonly exitCodes: readonly number[];
};

// domain-view: parse-produced draft-proof record; its wire form is the McpInputField proto message in data-models/.
type McpInputField = {
  readonly name: string;
  readonly type: McpInputType;
  readonly purpose: string;
  readonly required: boolean;
  readonly mapsToCliFlag?: string;
  readonly enumValues?: readonly string[];
};

// domain-view: parse-produced draft-proof record; its wire form is the McpInputSchema proto message in data-models/.
type McpInputSchema = {
  readonly schemaId: string;
  readonly fields: readonly McpInputField[];
};

type McpContract = {
  readonly toolName: string;
  readonly inputSchemaId: string;
  readonly inputSchema: McpInputSchema;
  readonly resultSchemaId: string;
  readonly safety: "read" | "write";
};

type OperationContract = {
  readonly id: OperationId;
  readonly cli: CliContract;
  readonly mcp: McpContract;
  readonly sharedCallPath: SharedCallPath;
  readonly sourceRefs: readonly string[];
  readonly lifecycleModes?: readonly LifecycleMode[];
  readonly feeds?: readonly FeedTarget[];
  readonly stateProduced?: string;
  readonly consumesState?: string;
  readonly migrationPhases?: readonly MigrationPhase[];
};

// domain-view: parse-produced draft-proof record; its wire form is the ResultEnvelope proto message in data-models/.
type ResultEnvelope = {
  readonly status: "ok" | "blocked" | "warning" | "handoff";
  readonly code: string;
  readonly humanMessage: string;
  readonly remediation: string;
  readonly proofMode: ProofMode;
  readonly fixtureId: string;
  readonly correlationId: string;
  readonly redactionClass: "public" | "tenant-safe" | "support-safe";
};

type Fixture = {
  readonly case: FixtureCase;
  readonly fixtureId: string;
  readonly proofMode: "reference-fixture";
  readonly cli: {
    readonly command: string;
    readonly stdout: ResultEnvelope;
  };
  readonly mcp: {
    readonly tool: string;
    readonly input: JsonObject;
    readonly result: ResultEnvelope;
  };
  readonly result: ResultEnvelope;
};

type CanonicalInvocation = {
  readonly tool: string;
  readonly input: JsonObject;
};

type CliMcpParityContract = {
  readonly issue: "HOBO-570";
  readonly phase: "M1";
  readonly project: "CLI, MCP & Developer Experience";
  readonly audienceModel: readonly string[];
  readonly operations: readonly OperationContract[];
  readonly forbiddenStandaloneVerbs: readonly ["deploy", "promote", "rollback", "yard up"];
  readonly fixtures: readonly Fixture[];
  readonly scopeOut: readonly string[];
};

declare const parsedCliMcpParityBrand: unique symbol;

export type ParsedCliMcpParityContract = CliMcpParityContract & {
  readonly [parsedCliMcpParityBrand]: true;
};

const SOURCE_REFS = [
  "docs/design/developer-experience.md#plan-07",
  "docs/design/sdk-api.md#plan-02",
  "docs/design/control-plane.md#plan-04",
  "docs/design/platform-engineering.md#plan-25",
  "docs/design/data-plane.md#plan-32",
] as const;

export const CLI_MCP_PARITY_CONTRACT: CliMcpParityContract = {
  issue: "HOBO-570",
  phase: "M1",
  project: "CLI, MCP & Developer Experience",
  audienceModel: [
    "application developer scripting resource lifecycle commands",
    "agent or MCP caller executing the same intent through tool schemas",
    "platform engineer reviewing plan, deploy, import, and migration outcomes",
    "support engineer receiving redacted evidence from doctor, inspect, and logs",
  ],
  operations: [
    operation("collect", "hobo collect [--camp <camp>] [--json]", "hobo.collect", "read", [
      flag("--camp", "Select the target Camp context for resource collection.", false),
      flag("--json", "Emit the manifest IR as JSON.", false),
    ]),
    operation("plan", "hobo plan [--camp <camp>] [--json]", "hobo.plan", "read", [
      flag("--camp", "Select the target Camp for the DeploymentPlan.", false),
      flag("--json", "Emit the DeploymentPlan and warnings as JSON.", false),
    ]),
    {
      ...operation("up", "hobo up [--camp <camp>] [--strategy <strategy>] [--to <revision>] [--rollback] [--json]", "hobo.up", "write", [
        flag("--camp", "Converge a target Camp or environment group.", false),
        flag("--strategy", "Request a rollout strategy such as canary.", false),
        flag("--to", "Realize a known revision for promote or rollback.", false),
        flag("--rollback", "Select the last-good revision through the same up gate.", false),
        flag("--json", "Emit the result envelope as JSON.", false),
      ]),
      lifecycleModes: ["deploy", "promote", "rollback"],
    },
    operation(
      "inspect",
      "hobo inspect run <id> | deploy <id> | topology [--json]",
      "hobo.inspect",
      "read",
      [
        flag("--json", "Emit projection snapshots as JSON.", false),
      ],
      [
        inputField("target", "enum", "Projection target to inspect.", true, undefined, ["run", "deploy", "topology"]),
        inputField("id", "string", "Run or deploy identifier; omitted for topology.", false),
        inputField("json", "boolean", "Emit projection snapshots as JSON.", false, "--json"),
      ],
    ),
    operation("logs", "hobo logs [--follow] [<resource>] [--json]", "hobo.logs", "read", [
      flag("--follow", "Follow the Camp runtime stream.", false),
      flag("--json", "Emit log envelopes as JSON.", false),
    ]),
    operation("doctor", "hobo doctor [--json]", "hobo.doctor", "read", [
      flag("--json", "Emit diagnostic findings as JSON.", false),
    ]),
    {
      ...operation(
        "import",
        "hobo import terraform|pulumi|opentofu <src> [--json]",
        "hobo.import",
        "write",
        [
          flag("--json", "Emit adopted-resource evidence as JSON.", false),
        ],
        [
          inputField("provider", "enum", "Brownfield source family to adopt.", true, undefined, [
            "terraform",
            "pulumi",
            "opentofu",
          ]),
          inputField("source", "string", "Repository, state file, or stack source to adopt.", true),
          inputField("json", "boolean", "Emit adopted-resource evidence as JSON.", false, "--json"),
        ],
      ),
      feeds: ["plan", "migrate"],
      stateProduced: "resource.Adopted",
    },
    {
      ...operation(
        "migrate",
        "hobo plan --migration <fixture> --adopted-resource <id> && hobo up --camp <camp> [--json]",
        "hobo.migrate",
        "write",
        [
          flag("--migration", "Plan expand/backfill/contract phases from declared data shape changes.", true),
          flag("--adopted-resource", "Bind migration to resource.Adopted evidence emitted by import.", true),
          flag("--camp", "Apply the gated migration phases through the target Camp.", true),
          flag("--json", "Emit migration phase and gate evidence as JSON.", false),
        ],
        [
          inputField("migration", "string", "Declared migration fixture for expand/backfill/contract phases.", true, "--migration"),
          inputField("camp", "string", "Camp where gated migration phases apply.", true, "--camp"),
          inputField("adoptedResourceId", "string", "resource.Adopted identifier emitted by hobo import.", true, "--adopted-resource"),
          inputField("json", "boolean", "Emit migration phase and gate evidence as JSON.", false, "--json"),
        ],
      ),
      feeds: ["up"],
      consumesState: "resource.Adopted",
      migrationPhases: ["expand", "backfill", "contract"],
    },
  ],
  forbiddenStandaloneVerbs: ["deploy", "promote", "rollback", "yard up"],
  fixtures: [
    fixture("successful-deploy", "hobo up --camp preview --json", "hobo.up", {
      camp: "preview",
      json: true,
    }, {
      status: "ok",
      code: "deployment.applied",
      humanMessage: "Preview Camp converged from the accepted DeploymentPlan fixture.",
      remediation: "Inspect the deployment or tail logs for follow-up evidence.",
    }),
    fixture("blocked-deploy", "hobo up --camp prod --json", "hobo.up", {
      camp: "prod",
      json: true,
    }, {
      status: "blocked",
      code: "gate.policy-denied",
      humanMessage: "Gatekeeper denied the prod Delta because approval is required.",
      remediation: "Request approval or rerun against a non-prod Camp.",
    }),
    fixture("stale-projection", "hobo inspect topology --json", "hobo.inspect", {
      target: "topology",
      json: true,
    }, {
      status: "warning",
      code: "projection.stale",
      humanMessage: "Topology snapshot is lagged beyond the accepted freshness window.",
      remediation: "Use the correlation id in support evidence or wait for the projection to catch up.",
    }),
    fixture("non-portable-edge", "hobo plan --camp prod --json", "hobo.plan", {
      camp: "prod",
      json: true,
    }, {
      status: "warning",
      code: "plan.non-portable-edge",
      humanMessage: "Plan includes a raw/adopted resource edge that breaks same-Bindle portability.",
      remediation: "Keep as explicit debt or replace it with a portable resource definition.",
    }),
    fixture("support-handoff", "hobo doctor --json", "hobo.doctor", {
      json: true,
    }, {
      status: "handoff",
      code: "support.evidence-pack-ready",
      humanMessage: "Doctor assembled a redacted support evidence pack from fixture snapshots.",
      remediation: "Attach the support-safe pack to the owner route without exposing customer data.",
    }),
  ],
  scopeOut: [
    "No production argument parser implementation.",
    "No live auth broker or live MCP server.",
    "No dashboard views or visual product UI.",
    "No lifecycle command behavior outside the accepted design docs.",
  ],
};

export function parseCliMcpParityContract(contract: CliMcpParityContract): ParsedCliMcpParityContract {
  const errors: string[] = [];

  if (contract.issue !== "HOBO-570") {
    errors.push("contract must pin HOBO-570");
  }
  if (contract.phase !== "M1") {
    errors.push("contract must stay in M1");
  }
  if (!arraysEqual(contract.operations.map((operation) => operation.id), REQUIRED_OPERATIONS)) {
    errors.push("operations must match required resource lifecycle operations");
  }
  if (!arraysEqual(contract.fixtures.map((item) => item.case), REQUIRED_FIXTURE_CASES)) {
    errors.push("fixtures must cover every accepted outcome case");
  }
  for (const operation of contract.operations) {
    if (!operation.cli.synopsis.startsWith("hobo ")) {
      errors.push(`${operation.id} CLI synopsis must start with hobo`);
    }
    if (!operation.mcp.toolName.startsWith("hobo.")) {
      errors.push(`${operation.id} MCP tool must use hobo namespace`);
    }
    if (operation.mcp.inputSchema.schemaId !== operation.mcp.inputSchemaId) {
      errors.push(`${operation.id} MCP input schema must match its schema id`);
    }
    if (operation.mcp.inputSchema.fields.length === 0) {
      errors.push(`${operation.id} MCP input schema must pin at least one field`);
    }
    const cliFlagNames = new Set(operation.cli.flags.map((cliFlag) => cliFlag.name));
    for (const field of operation.mcp.inputSchema.fields) {
      if (field.mapsToCliFlag && !cliFlagNames.has(field.mapsToCliFlag)) {
        errors.push(`${operation.id} MCP field ${field.name} maps to missing CLI flag ${field.mapsToCliFlag}`);
      }
    }
    if (operation.sharedCallPath !== "gateway-command-path") {
      errors.push(`${operation.id} must use shared gateway command path`);
    }
    if (!operation.cli.stdoutJsonSchemaId || !operation.mcp.resultSchemaId) {
      errors.push(`${operation.id} must name result schemas`);
    }
  }
  for (const fixtureItem of contract.fixtures) {
    if (!assertCliMcpParity(fixtureItem).equivalent) {
      errors.push(`${fixtureItem.case} CLI/MCP result parity failed`);
    }
  }
  for (const text of contract.scopeOut) {
    rejectScopeCreep(text, { allowScopeOutText: true });
  }

  if (errors.length > 0) {
    throw new CliMcpParityParseError(errors);
  }

  // SAFETY: `return contract as ParsedCliMcpParityContract;` is required at this I/O or test boundary.
  return contract as ParsedCliMcpParityContract;
}

export class CliMcpParityParseError extends Error {
  constructor(readonly errors: readonly string[]) {
    super(`CLI/MCP parity contract failed parsing: ${errors.join(", ")}`);
    this.name = "CliMcpParityParseError";
  }
}

export interface CliMcpParity {
  readonly case: FixtureCase;
  readonly equivalent: boolean;
}

export function assertCliMcpParity(fixtureItem: Fixture): CliMcpParity {
  const cliInvocation = canonicalCliInvocation(fixtureItem.cli.command);
  const mcpInvocation = {
    tool: fixtureItem.mcp.tool,
    input: fixtureItem.mcp.input,
  };

  return {
    case: fixtureItem.case,
    equivalent: semanticInvocation(cliInvocation) === semanticInvocation(mcpInvocation)
      && semanticResult(fixtureItem.cli.stdout) === semanticResult(fixtureItem.mcp.result)
      && semanticResult(fixtureItem.result) === semanticResult(fixtureItem.mcp.result),
  };
}

export function rejectScopeCreep(
  text: string,
  options: { readonly allowScopeOutText?: boolean } = {},
): void {
  const normalized = text.toLowerCase();

  if (/production argument parser/.test(normalized) && !options.allowScopeOutText) {
    throw new Error("production argument parser is scope-out");
  }
  if (/(live auth broker|live mcp server)/.test(normalized) && !options.allowScopeOutText) {
    throw new Error("live auth or MCP runtime is scope-out");
  }
  if (/(dashboard views|render dashboard|hobo promote|hobo deploy|hobo rollback|yard up)/.test(normalized)
    && !options.allowScopeOutText) {
    throw new Error("dashboard or invented lifecycle verb is scope-out");
  }
}

function operation(
  id: OperationId,
  synopsis: string,
  toolName: string,
  safety: "read" | "write",
  flags: readonly CliFlag[],
  mcpInputFields: readonly McpInputField[] = mcpFieldsFromFlags(flags),
): OperationContract {
  const inputSchemaId = `hobo.570.${id}.input/v1`;

  return {
    id,
    cli: {
      synopsis,
      flags,
      stdin: "none",
      stdoutJsonSchemaId: `hobo.570.${id}.result/v1`,
      stderr: ["human-readable explanation", "redacted diagnostics"],
      exitCodes: [0, 1, 2],
    },
    mcp: {
      toolName,
      inputSchemaId,
      inputSchema: {
        schemaId: inputSchemaId,
        fields: mcpInputFields,
      },
      resultSchemaId: `hobo.570.${id}.result/v1`,
      safety,
    },
    sharedCallPath: "gateway-command-path",
    sourceRefs: SOURCE_REFS,
  };
}

function flag(name: string, purpose: string, required: boolean): CliFlag {
  return { name, purpose, required };
}

function inputField(
  name: string,
  type: McpInputType,
  purpose: string,
  required: boolean,
  mapsToCliFlag?: string,
  enumValues?: readonly string[],
): McpInputField {
  return { name, type, purpose, required, mapsToCliFlag, enumValues };
}

function mcpFieldsFromFlags(flags: readonly CliFlag[]): readonly McpInputField[] {
  return flags.map((cliFlag) => inputField(
    cliFlag.name.replace(/^--/, "").replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()),
    /json|rollback|follow/.test(cliFlag.name) ? "boolean" : "string",
    cliFlag.purpose,
    cliFlag.required,
    cliFlag.name,
  ));
}

function fixture(
  fixtureCase: FixtureCase,
  command: string,
  tool: string,
  input: JsonObject,
  result: Pick<ResultEnvelope, "status" | "code" | "humanMessage" | "remediation">,
): Fixture {
  const fixtureId = `hobo-570-${fixtureCase}`;
  const envelope: ResultEnvelope = {
    ...result,
    proofMode: "reference-fixture",
    fixtureId,
    correlationId: `corr-${fixtureId}`,
    redactionClass: fixtureCase === "support-handoff" ? "support-safe" : "tenant-safe",
  };

  return {
    case: fixtureCase,
    fixtureId,
    proofMode: "reference-fixture",
    cli: {
      command,
      stdout: envelope,
    },
    mcp: {
      tool,
      input,
      result: envelope,
    },
    result: envelope,
  };
}

function semanticResult(result: ResultEnvelope): string {
  return JSON.stringify({
    status: result.status,
    code: result.code,
    humanMessage: result.humanMessage,
    remediation: result.remediation,
    proofMode: result.proofMode,
    fixtureId: result.fixtureId,
    correlationId: result.correlationId,
    redactionClass: result.redactionClass,
  });
}

function canonicalCliInvocation(command: string): CanonicalInvocation {
  const tokens = command.trim().split(/\s+/);
  const [binary, verb] = tokens;
  const input: JsonObject = {};

  if (binary !== "hobo" || !verb) {
    return { tool: "", input };
  }

  let index = 2;
  if (verb === "inspect" && tokens[index] && !tokens[index].startsWith("--")) {
    input.target = tokens[index];
    index += 1;
    if (tokens[index] && !tokens[index].startsWith("--")) {
      input.id = tokens[index];
      index += 1;
    }
  }
  if (verb === "import") {
    input.provider = tokens[index];
    input.source = tokens[index + 1];
    index += 2;
  }

  for (; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      continue;
    }
    if (token === "--json" || token === "--rollback" || token === "--follow") {
      input[flagToInputName(token)] = true;
      continue;
    }
    const value = tokens[index + 1];
    if (value && !value.startsWith("--")) {
      input[flagToInputName(token)] = value;
      index += 1;
    }
  }

  return {
    tool: `hobo.${verb}`,
    input,
  };
}

function flagToInputName(flagName: string): string {
  return flagName
    .replace(/^--/, "")
    .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function semanticInvocation(invocation: CanonicalInvocation): string {
  const sortedInput = Object.fromEntries(
    Object.entries(invocation.input)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  );

  return JSON.stringify({
    tool: invocation.tool,
    input: sortedInput,
  });
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
