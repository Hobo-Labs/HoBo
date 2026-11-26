import { isJsonObject, type JsonValue, type JsonObject } from "./json.js";
export const REQUIRED_MANAGE_STATES = [
  "normal-operation",
  "stale-projection",
  "non-reactive-sink-warning",
  "drift-detected",
  "support-handoff",
  "redacted-evidence-pack",
] as const;

export const REQUIRED_FIXTURE_SOURCES = [
  "run-inspector",
  "projection-freshness",
  "log-cursor",
  "drift",
  "token-audit",
  "support-evidence",
] as const;

type ManageState = (typeof REQUIRED_MANAGE_STATES)[number];
type FixtureSource = (typeof REQUIRED_FIXTURE_SOURCES)[number];
type ProofMode = "reference fixture";
type MachineStatus = "ok" | "warning" | "blocked" | "handoff";

// domain-view: parse-produced draft-proof record; its wire form is the CommandTranscript proto message in data-models/.
type CommandTranscript = {
  readonly command: string;
  readonly exitCode: 0 | 1 | 2;
};

// domain-view: parse-produced draft-proof record; its wire form is the MachineResult proto message in data-models/.
type MachineResult = {
  readonly status: MachineStatus;
  readonly code: string;
  readonly message: string;
  readonly remediation: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the RedactionEvidence proto message in data-models/.
type RedactionEvidence = {
  readonly redacted: true;
  readonly classification: "tenant-safe" | "support-safe";
  readonly visibleFields: readonly string[];
  readonly withheldFields: readonly string[];
};

// domain-view: parse-produced draft-proof record; its wire form is the HumanTranscript proto message in data-models/.
type HumanTranscript = {
  readonly summary: string;
  readonly lines: readonly string[];
  readonly accessibilityNotes: readonly string[];
};

// domain-view: parse-produced draft-proof record; its wire form is the McpToolCall proto message in data-models/.
type McpToolCall = {
  readonly tool: "hobo.inspect" | "hobo.logs" | "hobo.doctor";
  readonly input: Record<string, string | boolean>;
  readonly result: MachineResult;
};

// domain-view: parse-produced draft-proof record; its wire form is the ManageTranscriptScene proto message in data-models/.
export type ManageTranscriptScene = {
  readonly state: ManageState;
  readonly fixtureId: `hobo-574-${string}`;
  readonly fixtureSources: readonly FixtureSource[];
  readonly proofMode: ProofMode;
  readonly correlationId: `corr-hobo-574-${string}`;
  readonly cli: CommandTranscript;
  readonly mcp: McpToolCall;
  readonly machine: MachineResult;
  readonly human: HumanTranscript;
  readonly redaction: RedactionEvidence;
};

// domain-view: parse-produced draft-proof record; its wire form is the ManageTranscriptPrototype proto message in data-models/.
type ManageTranscriptPrototype = {
  readonly issue: "HOBO-574";
  readonly phase: "M2";
  readonly targetPackage: "src/draft/exp-proofs/dx/cli-manage-inspect-logs-drift-prototype";
  readonly proofNote: "docs/design/proofs/cli-manage-inspect-logs-drift-prototype/README.md";
  readonly designRefs: readonly string[];
  readonly scenes: readonly ManageTranscriptScene[];
  readonly scopeOut: readonly string[];
};

export type ParsedManageTranscriptPrototype = ManageTranscriptPrototype & {
  readonly __brand: "ParsedManageTranscriptPrototype";
};

export const CLI_MANAGE_TRANSCRIPT_PROTOTYPE: ManageTranscriptPrototype = {
  issue: "HOBO-574",
  phase: "M2",
  targetPackage: "src/draft/exp-proofs/dx/cli-manage-inspect-logs-drift-prototype",
  proofNote: "docs/design/proofs/cli-manage-inspect-logs-drift-prototype/README.md",
  designRefs: [
    "docs/design/developer-experience.md#plan-07",
    "docs/design/data-plane.md#plan-11",
    "docs/design/support-debug-tools.md",
    "docs/design/drift-reconciliation.md",
    "docs/design/audit-explorer.md",
    "src/draft/exp-proofs/dx/dx-resource-lifecycle-scenario-matrix/README.md",
    "src/draft/exp-proofs/ax/cli-mcp-parity-resource-lifecycle-contracts/README.md",
  ],
  scenes: [
    scene({
      state: "normal-operation",
      command: "hobo inspect run run_42 --json",
      tool: "hobo.inspect",
      input: { target: "run", id: "run_42", json: true },
      status: "ok",
      code: "run.timeline-current",
      message: "Run inspector projection is current at seq 184 and references deployment-set ds_42.",
      remediation: "Use the log cursor and ResourceActor timeline for follow-up inspection.",
      sources: ["run-inspector", "projection-freshness", "log-cursor"],
      summary: "Run timeline current; no support escalation needed.",
      lines: [
        "run run_42 current at projection seq 184",
        "last step checkout.api.ready completed from reference fixture hobo-574-normal-operation",
      ],
      accessibilityNotes: ["Status is present in text and JSON, not color only."],
    }),
    scene({
      state: "stale-projection",
      command: "hobo inspect topology --json",
      tool: "hobo.inspect",
      input: { target: "topology", json: true },
      status: "warning",
      code: "projection.stale",
      message: "Topology projection is 91 seconds behind the accepted freshness window.",
      remediation: "Wait for projection catch-up or attach the correlation id to a support-safe bundle.",
      sources: ["projection-freshness", "run-inspector"],
      summary: "Topology snapshot is stale and cannot be described as live state.",
      lines: [
        "topology projection stale by 91s",
        "proof mode: reference fixture, not live state",
      ],
      accessibilityNotes: ["Freshness warning is repeated in the first text line."],
    }),
    scene({
      state: "non-reactive-sink-warning",
      command: "hobo inspect deploy dep_42 --json",
      tool: "hobo.inspect",
      input: { target: "deploy", id: "dep_42", json: true },
      status: "warning",
      code: "projection.non-reactive-sink",
      message: "Deployment view is backed by a non-reactive sink and will not live-push changes.",
      remediation: "Treat the view as a snapshot and run doctor before using it for rollout decisions.",
      sources: ["projection-freshness", "run-inspector"],
      summary: "Deployment snapshot is readable, but the sink is non-reactive.",
      lines: [
        "deployment dep_42 snapshot seq 177",
        "warning: sink has no change-feed capability",
      ],
      accessibilityNotes: ["Warning prefix names the non-reactive capability gap."],
    }),
    scene({
      state: "drift-detected",
      command: "hobo doctor --resource api --json",
      tool: "hobo.doctor",
      input: { resource: "api", json: true },
      status: "blocked",
      code: "resource.drift-detected",
      message: "Doctor found api desired revision ds_42 but observed provider revision ds_40.",
      remediation: "Route to Operators/SRE for a drift proposal; do not auto-heal from this prototype.",
      sources: ["drift", "run-inspector", "support-evidence"],
      summary: "Drift is detected and routed without mutating live state.",
      lines: [
        "resource api drift detected",
        "safe next action: open governed drift proposal",
      ],
      accessibilityNotes: ["Blocked status and safe next action are text-first."],
    }),
    scene({
      state: "support-handoff",
      command: "hobo doctor --support-bundle run_42 --json",
      tool: "hobo.doctor",
      input: { supportBundle: "run_42", json: true },
      status: "handoff",
      code: "support.handoff-ready",
      message: "Doctor assembled support-safe owner, severity, projection, audit, and redaction evidence.",
      remediation: "Attach the support-safe bundle to the owner route without granting remediation authority.",
      sources: ["support-evidence", "token-audit", "projection-freshness"],
      summary: "Support handoff is ready with redacted evidence only.",
      lines: [
        "support bundle hobo-574-support-handoff ready",
        "visible fields: tenant, project, environment, correlation id, owner route",
      ],
      accessibilityNotes: ["Owner route and redaction state are available in plain text."],
    }),
    scene({
      state: "redacted-evidence-pack",
      command: "hobo logs --follow api --json",
      tool: "hobo.logs",
      input: { resource: "api", follow: true, json: true },
      status: "handoff",
      code: "support.redacted-evidence-pack",
      message: "Logs are replayed from a reference cursor and redacted before support packaging.",
      remediation: "Use the cursor and correlation id; never paste unredacted log payloads.",
      sources: ["log-cursor", "token-audit", "support-evidence"],
      summary: "Reference log cursor produced a support-safe evidence pack.",
      lines: [
        "logs api cursor logcur_42 replayed from reference fixture",
        "proof mode: reference fixture; this is not live log streaming",
      ],
      accessibilityNotes: ["The transcript names reference fixture mode beside the follow flag."],
    }),
  ],
  scopeOut: [
    "No production observability pipeline.",
    "No live log streaming.",
    "No real support tooling or ticket queue automation.",
    "No customer data or unredacted logs.",
    "No dashboard-first run inspector mockups.",
  ],
};

export function parseManageTranscriptPrototype(
  value: JsonValue,
): ParsedManageTranscriptPrototype {
  assertRecord(value, "prototype");
  assertLiteral(value.issue, "HOBO-574", "issue");
  assertLiteral(value.phase, "M2", "phase");
  assertLiteral(
    value.targetPackage,
    "src/draft/exp-proofs/dx/cli-manage-inspect-logs-drift-prototype",
    "targetPackage",
  );
  assertLiteral(
    value.proofNote,
    "docs/design/proofs/cli-manage-inspect-logs-drift-prototype/README.md",
    "proofNote",
  );

  const scenes = assertSceneArray(value.scenes);
  const states = scenes.map((item) => item.state);
  if (!arraysEqual(states, REQUIRED_MANAGE_STATES)) {
    throw new TypeError("scenes must cover the required manage states in order");
  }

  const sources = new Set(scenes.flatMap((item) => item.fixtureSources));
  for (const source of REQUIRED_FIXTURE_SOURCES) {
    if (!sources.has(source)) {
      throw new TypeError(`missing fixture source ${source}`);
    }
  }

  for (const sceneItem of scenes) {
    if (sceneItem.proofMode !== "reference fixture") {
      throw new TypeError(`${sceneItem.state} must stay reference fixture`);
    }
    if (!sceneItem.redaction.redacted || sceneItem.redaction.withheldFields.length === 0) {
      throw new TypeError(`${sceneItem.state} must carry redaction evidence`);
    }
    if (!assertCliMcpParity(sceneItem).equivalent) {
      throw new TypeError(`${sceneItem.state} CLI/MCP parity failed`);
    }
  }

  return {
    // SAFETY: `...(value as ManageTranscriptPrototype),` is required at this I/O or test boundary.
    ...(value as ManageTranscriptPrototype),
    __brand: "ParsedManageTranscriptPrototype",
  };
}

export function renderHumanTranscript(sceneItem: ManageTranscriptScene): string {
  return [
    `$ ${sceneItem.cli.command}`,
    sceneItem.human.summary,
    ...sceneItem.human.lines,
    `correlation: ${sceneItem.correlationId}`,
    `proof mode: ${sceneItem.proofMode}`,
  ].join("\n");
}

export interface JsonTranscript {
  readonly state: ManageState;
  readonly status: MachineStatus;
  readonly code: string;
  readonly message: string;
  readonly remediation: string;
  readonly fixtureId: string;
  readonly proofMode: ProofMode;
  readonly correlationId: string;
  readonly redaction: RedactionEvidence;
}

export interface CliMcpParity {
  readonly state: ManageState;
  readonly equivalent: boolean;
}

export function renderJsonTranscript(sceneItem: ManageTranscriptScene): JsonTranscript {
  return {
    state: sceneItem.state,
    status: sceneItem.machine.status,
    code: sceneItem.machine.code,
    message: sceneItem.machine.message,
    remediation: sceneItem.machine.remediation,
    fixtureId: sceneItem.fixtureId,
    proofMode: sceneItem.proofMode,
    correlationId: sceneItem.correlationId,
    redaction: sceneItem.redaction,
  };
}

export function assertCliMcpParity(sceneItem: ManageTranscriptScene): CliMcpParity {
  return {
    state: sceneItem.state,
    equivalent:
      semanticCli(sceneItem.cli.command) === semanticMcp(sceneItem.mcp)
      && semanticResult(sceneItem.machine) === semanticResult(sceneItem.mcp.result),
  };
}

export function classifyManagePrototypeScope(
  proposal: string,
):
  | { readonly allowed: true; readonly reason: "reference-fixture" }
  | {
      readonly allowed: false;
      readonly reason:
        | "production-observability"
        | "live-log-or-provider"
        | "customer-data"
        | "real-support-tooling"
        | "dashboard-first";
    } {
  const text = proposal.toLowerCase();
  if (/production observability|observability pipeline|metrics pipeline|trace collection/.test(text)) {
    return { allowed: false, reason: "production-observability" };
  }
  if (/live logs?|live log streaming|real provider|provider account|aws|azure|gcp/.test(text)) {
    return { allowed: false, reason: "live-log-or-provider" };
  }
  if (/customer data|raw customer|unredacted logs?|secret/.test(text)) {
    return { allowed: false, reason: "customer-data" };
  }
  if (/real support tooling|ticket queue|helpdesk|sla automation/.test(text)) {
    return { allowed: false, reason: "real-support-tooling" };
  }
  if (/dashboard-first|dashboard.*mockup|run inspector mockups/.test(text)) {
    return { allowed: false, reason: "dashboard-first" };
  }
  return { allowed: true, reason: "reference-fixture" };
}

function scene(input: {
  readonly state: ManageState;
  readonly command: string;
  readonly tool: McpToolCall["tool"];
  readonly input: McpToolCall["input"];
  readonly status: MachineStatus;
  readonly code: string;
  readonly message: string;
  readonly remediation: string;
  readonly sources: readonly FixtureSource[];
  readonly summary: string;
  readonly lines: readonly string[];
  readonly accessibilityNotes: readonly string[];
}): ManageTranscriptScene {
  const fixtureId = `hobo-574-${input.state}` as const;
  const machine: MachineResult = {
    status: input.status,
    code: input.code,
    message: input.message,
    remediation: input.remediation,
  };

  return {
    state: input.state,
    fixtureId,
    fixtureSources: input.sources,
    proofMode: "reference fixture",
    correlationId: `corr-${fixtureId}`,
    cli: {
      command: input.command,
      exitCode: input.status === "ok" ? 0 : input.status === "warning" ? 1 : 2,
    },
    mcp: {
      tool: input.tool,
      input: input.input,
      result: machine,
    },
    machine,
    human: {
      summary: input.summary,
      lines: input.lines,
      accessibilityNotes: input.accessibilityNotes,
    },
    redaction: {
      redacted: true,
      classification: input.state === "normal-operation" ? "tenant-safe" : "support-safe",
      visibleFields: ["tenant", "project", "environment", "correlationId", "ownerRoute"],
      withheldFields: ["rawLogPayload", "providerCredential", "secretValue", "customerPayload"],
    },
  };
}

function semanticCli(command: string): string {
  const tokens = command.split(/\s+/);
  const verb = tokens[1] ?? "";
  const input: Record<string, string | boolean> = {};
  let tool: McpToolCall["tool"] | "" = "";

  if (verb === "inspect") {
    tool = "hobo.inspect";
    input.target = tokens[2] ?? "";
    if (tokens[3] && !tokens[3].startsWith("--")) {
      input.id = tokens[3];
    }
  }
  if (verb === "logs") {
    tool = "hobo.logs";
    if (tokens.includes("--follow")) {
      input.follow = true;
    }
    const resource = tokens.find((token, index) => index > 1 && !token.startsWith("--"));
    if (resource) {
      input.resource = resource;
    }
  }
  if (verb === "doctor") {
    tool = "hobo.doctor";
    const resourceIndex = tokens.indexOf("--resource");
    if (resourceIndex >= 0) {
      input.resource = tokens[resourceIndex + 1] ?? "";
    }
    const supportBundleIndex = tokens.indexOf("--support-bundle");
    if (supportBundleIndex >= 0) {
      input.supportBundle = tokens[supportBundleIndex + 1] ?? "";
    }
  }
  if (tokens.includes("--json")) {
    input.json = true;
  }

  return JSON.stringify({ tool, input: sortObject(input) });
}

function semanticMcp(mcp: McpToolCall): string {
  return JSON.stringify({ tool: mcp.tool, input: sortObject(mcp.input) });
}

function semanticResult(result: MachineResult): string {
  return JSON.stringify(result);
}

function sortObject<T extends Record<string, string | boolean>>(value: T): T {
  // SAFETY: `return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.l` is required at this I/O or test boundary.
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) as T;
}

function assertSceneArray(value: JsonValue): ManageTranscriptScene[] {
  if (!Array.isArray(value)) {
    throw new TypeError("scenes must be an array");
  }
  return value.map((entry, index) => {
    assertRecord(entry, `scene ${index}`);
    // SAFETY: `if (!REQUIRED_MANAGE_STATES.includes(entry.state as ManageState)) {` is required at this I/O or test boundary.
    if (!REQUIRED_MANAGE_STATES.includes(entry.state as ManageState)) {
      throw new TypeError(`scene ${index} has unsupported state`);
    }
    if (!Array.isArray(entry.fixtureSources)) {
      throw new TypeError(`scene ${index} fixtureSources must be an array`);
    }
    for (const source of entry.fixtureSources) {
      // SAFETY: `if (!REQUIRED_FIXTURE_SOURCES.includes(source as FixtureSource)) {` is required at this I/O or test boundary.
      if (!REQUIRED_FIXTURE_SOURCES.includes(source as FixtureSource)) {
        throw new TypeError(`scene ${index} has unsupported fixture source ${String(source)}`);
      }
    }
    assertRecord(entry.redaction, `scene ${index} redaction`);
    // SAFETY: `return entry as ManageTranscriptScene;` is required at this I/O or test boundary.
    return entry as ManageTranscriptScene;
  });
}

function assertRecord(value: JsonValue, name: string): asserts value is JsonObject {
  if (value === null || !isJsonObject(value) || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function assertLiteral<T extends string>(value: JsonValue, expected: T, name: string): asserts value is T {
  if (value !== expected) {
    throw new TypeError(`${name} must be ${expected}`);
  }
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
